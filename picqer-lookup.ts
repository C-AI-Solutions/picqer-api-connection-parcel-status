/// <reference types="node" />

/**
 * Picqer Order Lookup Middleware
 *
 * Empfängt Webhook von Chatbot mit Shop-Code + Bestellnummer,
 * fragt die Picqer API ab und gibt formatierten Bestellstatus zurück.
 *
 */

/* ────────────────────────── Shop-Konfiguration ─────────────────────────── */

type ShopConfig = {
  apiKey: string;
  subdomain: string;
  label: string; // Anzeigename
};

/**
 * Mapping: Shop-Code → Picqer-Credentials
 * Neue Kunden hier eintragen. Codes sind case-insensitive.
 *
 * Alternativ: aus Datenbank oder Environment Variables laden.
 * z.B. SHOP_QY2025_KEY, SHOP_QY2025_SUBDOMAIN, etc.
 */
const SHOP_MAP: Record<string, ShopConfig> = {
  "QY-2025": {
    apiKey: process.env.PICQER_KEY_QYRA || "0LtuJHYfqIxaAdaAyjC8shl5z7WPiV7DzQ8xstjPXKRwkBXP",
    subdomain: "sellship",
    label: "QYRA",
  },
  // Weitere Kunden:
  // "XX-2025": {
  //   apiKey: process.env.PICQER_KEY_XX || "",
  //   subdomain: "sellship",
  //   label: "Anderer Kunde",
  // },
};

/* ──────────────────────────── Types ─────────────────────────────────────── */

type ReqBody = {
  code?: string;
  bestellnummer?: string;
};

type PicqerOrder = {
  idorder: number;
  orderid: string;
  reference: string | null;
  status: string;
  deliveryname: string;
  deliveryzipcode: string;
  deliverycity: string;
  deliverycountry: string;
  emailaddress: string | null;
  telephone: string | null;
  customer_remarks: string | null;
  public_status_page: string;
  created: string;
  updated: string;
  products: PicqerProduct[];
  picklists: PicqerPicklist[];
  tags: Record<string, PicqerTag>;
};

type PicqerProduct = {
  idorder_product: number;
  productcode: string;
  name: string;
  amount: number;
  amount_cancelled: number;
  price: number;
  weight: number;
  partof_idorder_product: number | null;
};

type PicqerPicklist = {
  idpicklist: number;
  picklistid: string;
  status: string;
  totalproducts: number;
  totalpicked: number;
  closed_at: string | null;
  created: string;
  updated: string;
};

type PicqerTag = {
  idtag: number;
  title: string;
  color: string;
};

type PicqerShipment = {
  idshipment: number;
  idorder: number;
  provider: string;
  providername: string;
  public_providername: string;
  carrier_key: string;
  weight: number;
  cancelled: boolean;
  created: string;
  parcels: PicqerParcel[];
};

type PicqerParcel = {
  idparcel: number;
  weight: number;
  tracking_code: string;
  tracking_url: string;
};

const VERSION = "picqer-lookup-v1";

/* ─────────────────────── Status-Übersetzungen ──────────────────────────── */

const ORDER_STATUS: Record<string, string> = {
  concept: "📝 Entwurf",
  expected: "📅 Erwartet",
  processing: "⚙️ In Bearbeitung",
  paused: "⏸️ Pausiert",
  completed: "✅ Abgeschlossen",
  cancelled: "❌ Storniert",
};

const PICKLIST_STATUS: Record<string, string> = {
  new: "🆕 Neu – wartet auf Picking",
  picking: "📋 Wird gerade gepickt",
  closed: "✅ Abgeschlossen & versandfertig",
  cancelled: "❌ Storniert",
  snoozed: "💤 Zurückgestellt",
};

/* ──────────────────────────── Handler ───────────────────────────────────── */

export default async function handler(req: any, res: any) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  try {
    const body: ReqBody =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    const code = body?.code?.trim().toUpperCase();
    const bestellnummer = body?.bestellnummer?.trim();

    /* ── Validierung ──────────────────────────────────────────────────── */

    if (!code || !bestellnummer) {
      return res.status(400).json({
        error: "Bitte Code und Bestellnummer angeben.",
        version: VERSION,
      });
    }

    // Shop-Code nachschlagen
    const shop = SHOP_MAP[code];
    if (!shop) {
      return res.status(403).json({
        message: `❌ Unbekannter Code: "${code}"\n\nBitte überprüfe deinen Shop-Code und versuche es erneut.`,
        version: VERSION,
      });
    }

    /* ── 1) Order suchen per Reference ────────────────────────────────── */

    const reference = bestellnummer.startsWith("#")
      ? bestellnummer
      : `#${bestellnummer}`;

    let orders = await picqerGet<PicqerOrder[]>(
      `/orders?reference=${encodeURIComponent(reference)}`,
      shop
    );

    // Fallback: Suche über das search-Feld (durchsucht orderid, reference, name)
    if (!orders || orders.length === 0) {
      orders = await picqerGet<PicqerOrder[]>(
        `/orders?search=${encodeURIComponent(bestellnummer)}`,
        shop
      );
    }

    if (!orders || orders.length === 0) {
      return res.status(404).json({
        message: `🔍 Keine Bestellung mit der Nummer "${bestellnummer}" gefunden.\n\nBitte überprüfe die Nummer und versuche es erneut.`,
        lookedUp: { code, bestellnummer },
        version: VERSION,
      });
    }

    const order = orders[0];

    /* ── 2) Shipments abrufen (pro Picklist) ──────────────────────────── */

    let shipments: PicqerShipment[] = [];

    if (order.picklists && order.picklists.length > 0) {
      for (const pl of order.picklists) {
        try {
          const plShipments = await picqerGet<PicqerShipment[]>(
            `/picklists/${pl.idpicklist}/shipments`,
            shop
          );
          if (Array.isArray(plShipments)) {
            shipments.push(...plShipments);
          }
        } catch {
          // Shipment-Endpoint nicht verfügbar – kein Problem
        }
      }
    }

    /* ── 3) Antwort formatieren ───────────────────────────────────────── */

    const response = formatResponse(order, shipments, shop.label);

    return res.status(200).json({
      message: response,
      raw: {
        order: {
          idorder: order.idorder,
          orderid: order.orderid,
          reference: order.reference,
          status: order.status,
          deliveryname: order.deliveryname,
          deliverycity: order.deliverycity,
          created: order.created,
          updated: order.updated,
          productsCount: order.products?.filter((p) => !p.partof_idorder_product).length,
          picklistsCount: order.picklists?.length,
        },
        shipments: shipments.map((s) => ({
          provider: s.public_providername || s.provider,
          cancelled: s.cancelled,
          tracking: s.parcels?.map((p) => ({
            code: p.tracking_code,
            url: p.tracking_url,
          })),
        })),
      },
      version: VERSION,
    });
  } catch (err: any) {
    return res.status(500).json({
      error: "Interner Fehler",
      detail: err?.message || String(err),
      version: VERSION,
    });
  }
}

/* ──────────────────────── Antwort formatieren ──────────────────────────── */

function formatResponse(
  order: PicqerOrder,
  shipments: PicqerShipment[],
  shopLabel: string
): string {
  const lines: string[] = [];

  const statusLabel = ORDER_STATUS[order.status] || order.status;

  lines.push(`📦 **Bestellung ${order.reference || order.orderid}** (${shopLabel})`);
  lines.push(``);
  lines.push(`**Status:** ${statusLabel}`);
  lines.push(`**Empfänger:** ${order.deliveryname}`);
  lines.push(`**Ort:** ${order.deliveryzipcode} ${order.deliverycity}`);
  lines.push(`**Erstellt:** ${formatDate(order.created)}`);

  // Produkte (nur Hauptprodukte, keine Bundle-Teile)
  const mainProducts = order.products?.filter((p) => !p.partof_idorder_product) || [];
  if (mainProducts.length > 0) {
    lines.push(``);
    lines.push(`**Produkte (${mainProducts.length}):**`);
    for (const p of mainProducts) {
      const cancelled = p.amount_cancelled > 0 ? ` (${p.amount_cancelled} storniert)` : "";
      lines.push(`• ${p.amount}× ${p.name}${cancelled}`);
    }
  }

  // Pickliste
  if (order.picklists && order.picklists.length > 0) {
    lines.push(``);
    lines.push(`**📋 Pickliste:**`);
    for (const pl of order.picklists) {
      const plStatus = PICKLIST_STATUS[pl.status] || pl.status;
      lines.push(`• ${pl.picklistid}: ${plStatus}`);
      lines.push(`  ${pl.totalpicked}/${pl.totalproducts} Produkte gepickt`);
      if (pl.closed_at) {
        lines.push(`  Abgeschlossen: ${formatDate(pl.closed_at)}`);
      }
    }
  } else {
    lines.push(``);
    lines.push(`📋 **Pickliste:** Noch nicht erstellt`);
  }

  // Versand & Tracking
  const activeShipments = shipments.filter((s) => !s.cancelled);

  if (activeShipments.length > 0) {
    lines.push(``);
    lines.push(`**🚚 Versand:**`);
    for (const s of activeShipments) {
      const provider = s.public_providername || s.providername || s.provider;
      lines.push(`• Versanddienstleister: **${provider}**`);
      lines.push(`  Versendet am: ${formatDate(s.created)}`);

      for (const parcel of s.parcels || []) {
        lines.push(`  Sendungsnummer: \`${parcel.tracking_code}\``);
        if (parcel.tracking_url) {
          lines.push(`  🔗 [Sendung verfolgen](${parcel.tracking_url})`);
        }
      }
    }
  } else if (order.status === "completed") {
    // Order completed aber kein Shipment gefunden – public status page als Fallback
    lines.push(``);
    lines.push(`**🚚 Versand:**`);
    lines.push(`Status-Seite: ${order.public_status_page}`);
  } else {
    lines.push(``);
    lines.push(`📭 **Versand:** Noch nicht versendet – Bestellung wird verarbeitet.`);
  }

  return lines.join("\n");
}

/* ──────────────────────── Picqer API Helper ────────────────────────────── */

async function picqerGet<T>(endpoint: string, shop: ShopConfig): Promise<T> {
  const url = `https://${shop.subdomain}.picqer.com/api/v1${endpoint}`;

  const resp = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: "Basic " + Buffer.from(shop.apiKey + ":").toString("base64"),
      "User-Agent": "ChatlinkBot (chatlink.com)",
      Accept: "application/json",
    },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Picqer API ${resp.status}: ${text.substring(0, 200)}`);
  }

  return resp.json() as Promise<T>;
}

/* ──────────────────────── Hilfsfunktionen ──────────────────────────────── */

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "–";
  const d = new Date(dateStr.replace(" ", "T") + "Z");
  return d.toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}