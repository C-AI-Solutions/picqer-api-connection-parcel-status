import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";

const VERSION = "picqer-lookup-azure-v2";

/* ────────────────────────── Shop-Konfiguration ─────────────────────────── */

type ShopConfig = {
  apiKey: string;
  subdomain: string;
  label: string;
};

function getShopConfig(code: string): ShopConfig | null {
  const shopsFromEnv = process.env.PICQER_SHOPS_JSON
    ? (JSON.parse(process.env.PICQER_SHOPS_JSON) as Record<string, ShopConfig>)
    : null;

  const shopMap = shopsFromEnv && Object.keys(shopsFromEnv).length > 0
    ? shopsFromEnv
    : {
        "QY-2025": {
          apiKey: process.env.PICQER_API_KEY || "",
          subdomain: process.env.PICQER_SUBDOMAIN || "sellship",
          label: process.env.PICQER_LABEL || "QYRA",
        },
      };

  return shopMap[code.trim().toUpperCase()] || null;
}

/**
 * DHL Tracking API Credentials
 * API Docs: https://developer.dhl.com/api-reference/shipment-tracking
 */
const DHL_API_KEY = process.env.DHL_API_KEY || "SZVYQcHgrvd7oGnKhO3wGs7FhZ6vlSX8";
const DHL_API_BASE = "https://api-eu.dhl.com/track/shipments";

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

type PicqerBackorder = {
  idbackorder: number;
  idorder_product: number;
  idorder: number;
  idproduct: number;
  idwarehouse: number;
  amount: number;
  amountavailable: number;
  amount_available: number;
  priority: number;
  date_available: string | null;
  created_at: string;
};

type DhlTrackingResult = {
  dhl_status: string;
  dhl_status_code: string;
  dhl_status_ort: string;
  dhl_status_zeit: string;
  dhl_lieferzeit: string;
  dhl_letztes_event: string;
  dhl_events: string;
  dhl_verfuegbar: boolean;
};

/* ─────────────────────── Status-Übersetzungen ──────────────────────────── */

const ORDER_STATUS: Record<string, string> = {
  concept: "📝 Entwurf",
  expected: "📅 Erwartet",
  processing: "⚙️ In Bearbeitung",
  paused: "⏸️ Pausiert",
  completed: "✅ Abgeschlossen",
  cancelled: "❌ Storniert",
};

const PICKLIST_STATUS_PICQER: Record<string, string> = {
  new: "🆕 Neu – wartet auf Picking",
  picking: "📋 Wird gerade gepickt",
  closed: "✅ Abgeschlossen & versandfertig",
  cancelled: "❌ Storniert",
  snoozed: "💤 Zurückgestellt",
  paused: "⏸️ Pausiert",
};

const PICKLIST_STATUS_NACHRICHTEN: Record<string, string> = {
  versendet:
    "Deine Bestellung wurde erfolgreich versendet! Nutze den Tracking-Link, um dein Paket zu verfolgen.",
  gepackt:
    "Deine Bestellung ist fertig gepackt und wird in Kürze an den Versanddienstleister übergeben.",
  in_bearbeitung:
    "Gute Nachrichten! Deine Bestellung wird gerade im Lager zusammengestellt. Der Versand erfolgt voraussichtlich heute noch.",
  wartend:
    "Deine Bestellung ist im Lager eingetroffen und wartet auf die Kommissionierung. Die Bearbeitung erfolgt in Kürze.",
  backorder_mit_datum:
    "Deine Bestellung wartet aktuell auf Ware vom Lieferanten. Voraussichtlich verfügbar am: {datum}. Sobald die Ware eingetroffen ist, wird deine Bestellung umgehend bearbeitet und versendet.",
  backorder_ohne_datum:
    "Deine Bestellung wartet aktuell auf Ware vom Lieferanten. Ein genaues Verfügbarkeitsdatum liegt leider noch nicht vor.",
  pausiert:
    "Die Bearbeitung deiner Bestellung ist momentan pausiert. Bei Fragen wende dich bitte an den Kundenservice.",
  storniert:
    "Diese Bestellung wurde storniert. Bei Fragen wende dich bitte an den Kundenservice.",
  vorbereitung:
    "Deine Bestellung wird gerade vorbereitet und in Kürze zur Kommissionierung freigegeben.",
  abgeschlossen:
    "Deine Bestellung ist vollständig abgeschlossen und wurde erfolgreich zugestellt.",
};

/* ─────────────────── DHL Status-Übersetzungen ──────────────────────────── */

const DHL_STATUS_MAP: Record<string, string> = {
  "pre-transit": "📋 Sendungsdaten übermittelt",
  transit: "🚚 Sendung unterwegs",
  delivered: "✅ Zugestellt",
  failure: "⚠️ Zustellversuch fehlgeschlagen",
  unknown: "❓ Status unbekannt",
};

/* ----------------------------- CORS -------------------------------------- */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

/* ----------------------------- Handler ----------------------------------- */

app.http("picqer-lookup", {
  methods: ["GET", "POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (request: HttpRequest, _ctx: InvocationContext): Promise<HttpResponseInit> => {
    if (request.method === "OPTIONS") {
      return { status: 200, headers: CORS };
    }
    if (request.method !== "POST") {
      return { status: 405, headers: CORS, jsonBody: { error: "Use POST" } };
    }

    let body: ReqBody;
    try {
      body = (await request.json()) as ReqBody;
    } catch {
      return { status: 400, headers: CORS, jsonBody: { error: "Invalid JSON body" } };
    }

    const code = body?.code?.trim().toUpperCase();
    const bestellnummer = body?.bestellnummer?.trim();

    if (!code || !bestellnummer) {
      return {
        status: 400,
        headers: CORS,
        jsonBody: { error: "Bitte Code und Bestellnummer angeben.", version: VERSION },
      };
    }

    const shop = getShopConfig(code);
    if (!shop) {
      return {
        status: 403,
        headers: CORS,
        jsonBody: {
          message: `❌ Unbekannter Code: "${code}"\n\nBitte überprüfe deinen Shop-Code und versuche es erneut.`,
          version: VERSION,
        },
      };
    }

    try {
      /* ── 1) Order suchen per Reference ──────────────────────────────── */

      const reference = bestellnummer.startsWith("#") ? bestellnummer : `#${bestellnummer}`;

      let orders = await picqerGet<PicqerOrder[]>(
        `/orders?reference=${encodeURIComponent(reference)}`,
        shop
      );

      if (!orders || orders.length === 0) {
        orders = await picqerGet<PicqerOrder[]>(
          `/orders?search=${encodeURIComponent(bestellnummer)}`,
          shop
        );
      }

      if (!orders || orders.length === 0) {
        return {
          status: 404,
          headers: CORS,
          jsonBody: {
            message: `🔍 Keine Bestellung mit der Nummer "${bestellnummer}" gefunden.\n\nBitte überprüfe die Nummer und versuche es erneut.`,
            version: VERSION,
          },
        };
      }

      const order = orders[0];

      /* ── 2) Shipments abrufen ────────────────────────────────────────── */

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
            // Shipment-Endpoint nicht verfügbar
          }
        }
      }

      /* ── 3) Backorders abrufen ───────────────────────────────────────── */

      let backorders: PicqerBackorder[] = [];
      let backorderDatum = "";

      try {
        const boResult = await picqerGet<PicqerBackorder[]>(
          `/orders/${order.idorder}/backorders`,
          shop
        );
        if (Array.isArray(boResult) && boResult.length > 0) {
          backorders = boResult;
          const datesAvailable = backorders
            .map((bo) => bo.date_available)
            .filter((d): d is string => d !== null && d !== "");
          if (datesAvailable.length > 0) {
            datesAvailable.sort((a, b) => new Date(b).getTime() - new Date(a).getTime());
            backorderDatum = formatDateShort(datesAvailable[0]);
          }
        }
      } catch {
        // Backorder-Endpoint nicht verfügbar
      }

      /* ── 4) picklist_status + picklist_status_nachricht ermitteln ───── */

      const activeShipment = shipments.find((s) => !s.cancelled) || null;
      const firstParcel = activeShipment?.parcels?.[0] || null;
      const pl = order.picklists?.[0] || null;

      const { picklistStatus, picklistStatusNachricht } = getPicklistStatus(
        order, pl, activeShipment, backorders, backorderDatum
      );

      /* ── 5) DHL Tracking abrufen (nur wenn versendet + Sendungsnr.) ── */

      let dhlTracking: DhlTrackingResult = {
        dhl_status: "",
        dhl_status_code: "",
        dhl_status_ort: "",
        dhl_status_zeit: "",
        dhl_lieferzeit: "",
        dhl_letztes_event: "",
        dhl_events: "",
        dhl_verfuegbar: false,
      };

      let dhl_debug = "";

      if (picklistStatus === "versendet" && firstParcel?.tracking_code) {
        try {
          dhlTracking = await fetchDhlTracking(
            firstParcel.tracking_code,
            order.deliveryzipcode
          );
          dhl_debug = dhlTracking.dhl_verfuegbar ? "OK" : "Keine Daten von DHL";
        } catch (err: any) {
          dhl_debug = `DHL Fehler: ${err?.message || String(err)}`;
        }
      } else {
        dhl_debug = `Kein DHL-Call: status=${picklistStatus}, tracking=${firstParcel?.tracking_code || "leer"}`;
      }

      /* ── 6) Response bauen ───────────────────────────────────────────── */

      const mainProducts = order.products?.filter((p) => !p.partof_idorder_product) || [];
      const produkteListe = mainProducts
        .map((p) => {
          const cancelled = p.amount_cancelled > 0 ? ` (${p.amount_cancelled} storniert)` : "";
          return `${p.amount}× ${p.name}${cancelled}`;
        })
        .join("\n");

      return {
        status: 200,
        headers: CORS,
        jsonBody: {
          bestellnummer:              order.reference || order.orderid,
          picqer_orderid:             order.orderid,
          bestell_status:             ORDER_STATUS[order.status] || order.status,
          empfaenger:                 order.deliveryname || "",
          plz:                        order.deliveryzipcode || "",
          stadt:                      order.deliverycity || "",
          land:                       order.deliverycountry || "",
          email:                      order.emailaddress || "",
          telefon:                    order.telephone || "",
          bestellt_am:                formatDate(order.created),
          aktualisiert_am:            formatDate(order.updated),
          produkte_anzahl:            mainProducts.length,
          produkte_liste:             produkteListe || "Keine Produkte",
          picklist_status:            picklistStatus,
          picklist_status_nachricht:  picklistStatusNachricht,
          picklist_status_picqer:     pl ? (PICKLIST_STATUS_PICQER[pl.status] || pl.status) : "Noch nicht erstellt",
          picklist_id:                pl?.picklistid || "",
          produkte_gepickt:           pl?.totalpicked ?? "",
          produkte_gesamt:            pl?.totalproducts ?? "",
          picklist_abgeschlossen:     pl?.closed_at ? formatDate(pl.closed_at) : "",
          versanddienstleister:       activeShipment?.public_providername || activeShipment?.providername || activeShipment?.provider || "",
          sendungsnummer:             firstParcel?.tracking_code || "",
          tracking_link:              firstParcel?.tracking_url || "",
          versendet_am:               activeShipment ? formatDate(activeShipment.created) : "",
          gewicht:                    activeShipment?.weight ? `${activeShipment.weight}g` : "",
          versand_storniert:          activeShipment?.cancelled ?? false,
          dhl_status:                 dhlTracking.dhl_status,
          dhl_status_code:            dhlTracking.dhl_status_code,
          dhl_status_ort:             dhlTracking.dhl_status_ort,
          dhl_status_zeit:            dhlTracking.dhl_status_zeit,
          dhl_lieferzeit:             dhlTracking.dhl_lieferzeit,
          dhl_letztes_event:          dhlTracking.dhl_letztes_event,
          dhl_events:                 dhlTracking.dhl_events,
          dhl_verfuegbar:             dhlTracking.dhl_verfuegbar,
          dhl_debug:                  dhl_debug,
          backorder_vorhanden:        backorders.length > 0,
          backorder_anzahl:           backorders.length,
          backorder_datum:            backorderDatum,
          public_status_page:         order.public_status_page || "",
          message:                    formatMessage(order, shipments, shop.label),
          version:                    VERSION,
        },
      };
    } catch (err: any) {
      return {
        status: 500,
        headers: CORS,
        jsonBody: { error: "Interner Fehler", detail: err?.message || String(err), version: VERSION },
      };
    }
  },
});

/* ──────────────────── DHL Tracking API ──────────────────────────────────── */

async function fetchDhlTracking(
  trackingCode: string,
  recipientPostalCode?: string
): Promise<DhlTrackingResult> {
  const empty: DhlTrackingResult = {
    dhl_status: "",
    dhl_status_code: "",
    dhl_status_ort: "",
    dhl_status_zeit: "",
    dhl_lieferzeit: "",
    dhl_letztes_event: "",
    dhl_events: "",
    dhl_verfuegbar: false,
  };

  let url = `${DHL_API_BASE}?trackingNumber=${encodeURIComponent(trackingCode)}&language=de`;
  if (recipientPostalCode) {
    url += `&recipientPostalCode=${encodeURIComponent(recipientPostalCode)}`;
  }

  const resp = await fetch(url, {
    method: "GET",
    headers: {
      "DHL-API-Key": DHL_API_KEY,
      Accept: "application/json",
    },
  });

  if (!resp.ok) {
    const errorText = await resp.text();
    throw new Error(`DHL API ${resp.status}: ${errorText.substring(0, 200)}`);
  }

  const data = await resp.json();
  const shipment = data?.shipments?.[0];

  if (!shipment) {
    return empty;
  }

  const statusCode = shipment.status?.statusCode || "";
  const statusLabel = DHL_STATUS_MAP[statusCode] || shipment.status?.status || statusCode;
  const statusDescription = shipment.status?.description || shipment.status?.status || "";
  const statusOrt = shipment.status?.location?.address?.addressLocality || "";
  const statusZeit = shipment.status?.timestamp
    ? formatDate(shipment.status.timestamp)
    : "";

  let lieferzeit = "";
  if (shipment.estimatedTimeOfDelivery?.date) {
    lieferzeit = formatDateShort(shipment.estimatedTimeOfDelivery.date);
    if (shipment.estimatedTimeOfDelivery.estimatedTimeOfDeliveryRemark) {
      lieferzeit += ` (${shipment.estimatedTimeOfDelivery.estimatedTimeOfDeliveryRemark})`;
    }
  }

  let eventsText = "";
  if (Array.isArray(shipment.events) && shipment.events.length > 0) {
    const recentEvents = shipment.events.slice(0, 5);
    eventsText = recentEvents
      .map((ev: any) => {
        const zeit = ev.timestamp ? formatDate(ev.timestamp) : "";
        const ort = ev.location?.address?.addressLocality || "";
        const beschreibung = ev.description || ev.status || "";
        return `${zeit}${ort ? ` – ${ort}` : ""}: ${beschreibung}`;
      })
      .join("\n");
  }

  return {
    dhl_status: statusLabel,
    dhl_status_code: statusCode,
    dhl_status_ort: statusOrt,
    dhl_status_zeit: statusZeit,
    dhl_lieferzeit: lieferzeit,
    dhl_letztes_event: statusDescription,
    dhl_events: eventsText,
    dhl_verfuegbar: true,
  };
}

/* ──────────── picklist_status + picklist_status_nachricht ─────────────── */

function getPicklistStatus(
  order: PicqerOrder,
  picklist: PicqerPicklist | null,
  activeShipment: PicqerShipment | null,
  backorders: PicqerBackorder[],
  backorderDatum: string
): { picklistStatus: string; picklistStatusNachricht: string } {

  if (order.status === "cancelled") {
    return { picklistStatus: "storniert", picklistStatusNachricht: PICKLIST_STATUS_NACHRICHTEN.storniert };
  }

  if (order.status === "completed" && !picklist) {
    return { picklistStatus: "abgeschlossen", picklistStatusNachricht: PICKLIST_STATUS_NACHRICHTEN.abgeschlossen };
  }

  if (order.status === "concept" || order.status === "expected") {
    return { picklistStatus: "vorbereitung", picklistStatusNachricht: PICKLIST_STATUS_NACHRICHTEN.vorbereitung };
  }

  if (!picklist) {
    if (backorders.length > 0) {
      if (backorderDatum) {
        return {
          picklistStatus: "backorder_mit_datum",
          picklistStatusNachricht: PICKLIST_STATUS_NACHRICHTEN.backorder_mit_datum.replace("{datum}", backorderDatum),
        };
      }
      return { picklistStatus: "backorder_ohne_datum", picklistStatusNachricht: PICKLIST_STATUS_NACHRICHTEN.backorder_ohne_datum };
    }
    return { picklistStatus: "vorbereitung", picklistStatusNachricht: PICKLIST_STATUS_NACHRICHTEN.vorbereitung };
  }

  switch (picklist.status) {
    case "new":
      return { picklistStatus: "wartend", picklistStatusNachricht: PICKLIST_STATUS_NACHRICHTEN.wartend };
    case "picking":
      return { picklistStatus: "in_bearbeitung", picklistStatusNachricht: PICKLIST_STATUS_NACHRICHTEN.in_bearbeitung };
    case "snoozed":
    case "paused":
      return { picklistStatus: "pausiert", picklistStatusNachricht: PICKLIST_STATUS_NACHRICHTEN.pausiert };
    case "closed":
      if (activeShipment) {
        return { picklistStatus: "versendet", picklistStatusNachricht: PICKLIST_STATUS_NACHRICHTEN.versendet };
      }
      return { picklistStatus: "gepackt", picklistStatusNachricht: PICKLIST_STATUS_NACHRICHTEN.gepackt };
    case "cancelled":
      return { picklistStatus: "storniert", picklistStatusNachricht: PICKLIST_STATUS_NACHRICHTEN.storniert };
    default:
      return { picklistStatus: "vorbereitung", picklistStatusNachricht: PICKLIST_STATUS_NACHRICHTEN.vorbereitung };
  }
}

/* ──────────────────── Zusammenfassende Message ─────────────────────────── */

function formatMessage(order: PicqerOrder, shipments: PicqerShipment[], shopLabel: string): string {
  const status = ORDER_STATUS[order.status] || order.status;
  const activeShipment = shipments.find((s) => !s.cancelled);
  const parcel = activeShipment?.parcels?.[0];

  let msg = `📦 Bestellung ${order.reference || order.orderid} (${shopLabel})\n`;
  msg += `Status: ${status}\n`;
  msg += `Empfänger: ${order.deliveryname}, ${order.deliveryzipcode} ${order.deliverycity}`;

  if (parcel) {
    const provider = activeShipment?.public_providername || activeShipment?.provider || "";
    msg += `\n🚚 Versendet mit ${provider}\nSendungsnummer: ${parcel.tracking_code}`;
  }

  return msg;
}

/* ──────────────────────── Picqer API Helper ────────────────────────────── */

async function picqerGet<T>(endpoint: string, shop: ShopConfig): Promise<T> {
  const url = `https://${shop.subdomain}.picqer.com/api/v1${endpoint}`;
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: "Basic " + Buffer.from(shop.apiKey + ":").toString("base64"),
      "User-Agent": "SellshipMiddleware",
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
  if (!dateStr) return "";
  const d = new Date(dateStr.replace(" ", "T") + (dateStr.includes("+") || dateStr.includes("Z") ? "" : "Z"));
  return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatDateShort(dateStr: string | null): string {
  if (!dateStr) return "";
  const d = new Date(dateStr.replace(" ", "T") + (dateStr.includes("+") || dateStr.includes("Z") ? "" : "Z"));
  return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
}