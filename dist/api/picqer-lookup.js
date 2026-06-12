"use strict";
/// <reference types="node" />
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = handler;
/**
 * Mapping: Shop-Code → Picqer-Credentials
 *
 * Credentials are loaded from Azure Function App Settings at runtime.
 * For multiple shops, set PICQER_SHOPS_JSON with a JSON object.
 */
function getShopConfig(code) {
    const shopsFromEnv = process.env.PICQER_SHOPS_JSON
        ? JSON.parse(process.env.PICQER_SHOPS_JSON)
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
const VERSION = "picqer-lookup-v4";
/* ─────────────────────── Status-Übersetzungen ──────────────────────────── */
const ORDER_STATUS = {
    concept: "📝 Entwurf",
    expected: "📅 Erwartet",
    processing: "⚙️ In Bearbeitung",
    paused: "⏸️ Pausiert",
    completed: "✅ Abgeschlossen",
    cancelled: "❌ Storniert",
};
const PICKLIST_STATUS_PICQER = {
    new: "🆕 Neu – wartet auf Picking",
    picking: "📋 Wird gerade gepickt",
    closed: "✅ Abgeschlossen & versandfertig",
    cancelled: "❌ Storniert",
    snoozed: "💤 Zurückgestellt",
    paused: "⏸️ Pausiert",
};
/* ──────────────── Picklist-Status-Nachrichten (Platzhalter) ────────────── */
/**
 * Hier die Texte für jede Statusmeldung anpassen.
 * Diese Texte werden als Variable "picklist_status_nachricht" an Chatling übergeben.
 * {datum} wird automatisch durch das Backorder-Datum ersetzt, falls vorhanden.
 */
const PICKLIST_STATUS_NACHRICHTEN = {
    // ── picklist_status = "versendet" ──
    versendet: "Deine Bestellung wurde erfolgreich versendet! Nutze den Tracking-Link, um dein Paket zu verfolgen.",
    // ── picklist_status = "gepackt" ──
    gepackt: "Deine Bestellung ist fertig gepackt und wird in Kürze an den Versanddienstleister übergeben.",
    // ── picklist_status = "in_bearbeitung" ──
    in_bearbeitung: "Gute Nachrichten! Deine Bestellung wird gerade im Lager zusammengestellt. Der Versand erfolgt voraussichtlich heute noch.",
    // ── picklist_status = "wartend" ──
    wartend: "Deine Bestellung ist im Lager eingetroffen und wartet auf die Kommissionierung. Die Bearbeitung erfolgt in Kürze.",
    // ── picklist_status = "backorder_mit_datum" ──
    backorder_mit_datum: "Deine Bestellung wartet aktuell auf Ware vom Lieferanten. Voraussichtlich verfügbar am: {datum}. Sobald die Ware eingetroffen ist, wird deine Bestellung umgehend bearbeitet und versendet.",
    // ── picklist_status = "backorder_ohne_datum" ──
    backorder_ohne_datum: "Deine Bestellung wartet aktuell auf Ware vom Lieferanten. Ein genaues Verfügbarkeitsdatum liegt leider noch nicht vor.",
    // ── picklist_status = "pausiert" ──
    pausiert: "Die Bearbeitung deiner Bestellung ist momentan pausiert. Bei Fragen wende dich bitte an den Kundenservice.",
    // ── picklist_status = "storniert" ──
    storniert: "Diese Bestellung wurde storniert. Bei Fragen wende dich bitte an den Kundenservice.",
    // ── picklist_status = "vorbereitung" ──
    vorbereitung: "Deine Bestellung wird gerade vorbereitet und in Kürze zur Kommissionierung freigegeben.",
    // ── picklist_status = "abgeschlossen" ──
    abgeschlossen: "Deine Bestellung ist vollständig abgeschlossen und wurde erfolgreich zugestellt.",
};
/* ──────────────────────────── Handler ───────────────────────────────────── */
async function handler(req, res) {
    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS")
        return res.status(200).end();
    if (req.method !== "POST")
        return res.status(405).json({ error: "Use POST" });
    try {
        const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
        const code = body?.code?.trim().toUpperCase();
        const bestellnummer = body?.bestellnummer?.trim();
        /* ── Validierung ──────────────────────────────────────────────────── */
        if (!code || !bestellnummer) {
            return res.status(400).json({
                error: "Bitte Code und Bestellnummer angeben.",
                version: VERSION,
            });
        }
        const shop = await getShopConfig(code);
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
        let orders = await picqerGet(`/orders?reference=${encodeURIComponent(reference)}`, shop);
        if (!orders || orders.length === 0) {
            orders = await picqerGet(`/orders?search=${encodeURIComponent(bestellnummer)}`, shop);
        }
        if (!orders || orders.length === 0) {
            return res.status(404).json({
                message: `🔍 Keine Bestellung mit der Nummer "${bestellnummer}" gefunden.\n\nBitte überprüfe die Nummer und versuche es erneut.`,
                version: VERSION,
            });
        }
        const order = orders[0];
        /* ── 2) Shipments abrufen (pro Picklist) ──────────────────────────── */
        let shipments = [];
        if (order.picklists && order.picklists.length > 0) {
            for (const pl of order.picklists) {
                try {
                    const plShipments = await picqerGet(`/picklists/${pl.idpicklist}/shipments`, shop);
                    if (Array.isArray(plShipments)) {
                        shipments.push(...plShipments);
                    }
                }
                catch {
                    // Shipment-Endpoint nicht verfügbar
                }
            }
        }
        /* ── 3) Backorders abrufen ────────────────────────────────────────── */
        let backorders = [];
        let backorderDatum = "";
        try {
            const boResult = await picqerGet(`/orders/${order.idorder}/backorders`, shop);
            if (Array.isArray(boResult) && boResult.length > 0) {
                backorders = boResult;
                // Das späteste Verfügbarkeitsdatum aller Backorders nehmen
                // (= wann die gesamte Bestellung lieferbar ist)
                const datesAvailable = backorders
                    .map((bo) => bo.date_available)
                    .filter((d) => d !== null && d !== "");
                if (datesAvailable.length > 0) {
                    datesAvailable.sort((a, b) => new Date(b).getTime() - new Date(a).getTime());
                    backorderDatum = formatDateShort(datesAvailable[0]);
                }
            }
        }
        catch {
            // Backorder-Endpoint nicht verfügbar (z.B. bei Fulfilment-Keys)
        }
        /* ── 4) picklist_status + picklist_status_nachricht ermitteln ──────── */
        const activeShipment = shipments.find((s) => !s.cancelled) || null;
        const firstParcel = activeShipment?.parcels?.[0] || null;
        const pl = order.picklists?.[0] || null;
        const { picklistStatus, picklistStatusNachricht } = getPicklistStatus(order, pl, activeShipment, backorders, backorderDatum);
        /* ── 5) Flache Response bauen ─────────────────────────────────────── */
        // Hauptprodukte (ohne Bundle-Teile)
        const mainProducts = order.products?.filter((p) => !p.partof_idorder_product) || [];
        const produkteListe = mainProducts
            .map((p) => {
            const cancelled = p.amount_cancelled > 0 ? ` (${p.amount_cancelled} storniert)` : "";
            return `${p.amount}× ${p.name}${cancelled}`;
        })
            .join("\n");
        const response = {
            // ── Bestellung ──
            bestellnummer: order.reference || order.orderid,
            picqer_orderid: order.orderid,
            bestell_status: ORDER_STATUS[order.status] || order.status,
            empfaenger: order.deliveryname || "",
            plz: order.deliveryzipcode || "",
            stadt: order.deliverycity || "",
            land: order.deliverycountry || "",
            email: order.emailaddress || "",
            telefon: order.telephone || "",
            bestellt_am: formatDate(order.created),
            aktualisiert_am: formatDate(order.updated),
            produkte_anzahl: mainProducts.length,
            produkte_liste: produkteListe || "Keine Produkte",
            // ── Pickliste (Flow-Steuerung für Chatling if-else) ──
            picklist_status: picklistStatus,
            picklist_status_nachricht: picklistStatusNachricht,
            picklist_status_picqer: pl ? (PICKLIST_STATUS_PICQER[pl.status] || pl.status) : "Noch nicht erstellt",
            picklist_id: pl?.picklistid || "",
            produkte_gepickt: pl?.totalpicked ?? "",
            produkte_gesamt: pl?.totalproducts ?? "",
            picklist_abgeschlossen: pl?.closed_at ? formatDate(pl.closed_at) : "",
            // ── Versand & Tracking ──
            versanddienstleister: activeShipment?.public_providername || activeShipment?.providername || activeShipment?.provider || "",
            sendungsnummer: firstParcel?.tracking_code || "",
            tracking_link: firstParcel?.tracking_url || "",
            versendet_am: activeShipment ? formatDate(activeShipment.created) : "",
            gewicht: activeShipment?.weight ? `${activeShipment.weight}g` : "",
            versand_storniert: activeShipment?.cancelled ?? false,
            // ── Backorder ──
            backorder_vorhanden: backorders.length > 0,
            backorder_anzahl: backorders.length,
            backorder_datum: backorderDatum,
            // ── Meta ──
            public_status_page: order.public_status_page || "",
            message: formatMessage(order, shipments, shop.label),
            version: VERSION,
        };
        return res.status(200).json(response);
    }
    catch (err) {
        return res.status(500).json({
            error: "Interner Fehler",
            detail: err?.message || String(err),
            version: VERSION,
        });
    }
}
/* ──────────── picklist_status + picklist_status_nachricht ─────────────── */
function getPicklistStatus(order, picklist, activeShipment, backorders, backorderDatum) {
    // ── 1) Order-Level Status zuerst prüfen ──
    if (order.status === "cancelled") {
        return {
            picklistStatus: "storniert",
            picklistStatusNachricht: PICKLIST_STATUS_NACHRICHTEN.storniert,
        };
    }
    if (order.status === "completed" && !picklist) {
        return {
            picklistStatus: "abgeschlossen",
            picklistStatusNachricht: PICKLIST_STATUS_NACHRICHTEN.abgeschlossen,
        };
    }
    if (order.status === "concept" || order.status === "expected") {
        return {
            picklistStatus: "vorbereitung",
            picklistStatusNachricht: PICKLIST_STATUS_NACHRICHTEN.vorbereitung,
        };
    }
    // ── 2) Keine Picklist vorhanden ──
    if (!picklist) {
        if (backorders.length > 0) {
            if (backorderDatum) {
                return {
                    picklistStatus: "backorder_mit_datum",
                    picklistStatusNachricht: PICKLIST_STATUS_NACHRICHTEN.backorder_mit_datum.replace("{datum}", backorderDatum),
                };
            }
            return {
                picklistStatus: "backorder_ohne_datum",
                picklistStatusNachricht: PICKLIST_STATUS_NACHRICHTEN.backorder_ohne_datum,
            };
        }
        return {
            picklistStatus: "vorbereitung",
            picklistStatusNachricht: PICKLIST_STATUS_NACHRICHTEN.vorbereitung,
        };
    }
    // ── 3) Picklist vorhanden – Status auswerten ──
    switch (picklist.status) {
        case "new":
            return {
                picklistStatus: "wartend",
                picklistStatusNachricht: PICKLIST_STATUS_NACHRICHTEN.wartend,
            };
        case "picking":
            return {
                picklistStatus: "in_bearbeitung",
                picklistStatusNachricht: PICKLIST_STATUS_NACHRICHTEN.in_bearbeitung,
            };
        case "snoozed":
        case "paused":
            return {
                picklistStatus: "pausiert",
                picklistStatusNachricht: PICKLIST_STATUS_NACHRICHTEN.pausiert,
            };
        case "closed":
            if (activeShipment) {
                return {
                    picklistStatus: "versendet",
                    picklistStatusNachricht: PICKLIST_STATUS_NACHRICHTEN.versendet,
                };
            }
            return {
                picklistStatus: "gepackt",
                picklistStatusNachricht: PICKLIST_STATUS_NACHRICHTEN.gepackt,
            };
        case "cancelled":
            return {
                picklistStatus: "storniert",
                picklistStatusNachricht: PICKLIST_STATUS_NACHRICHTEN.storniert,
            };
        default:
            return {
                picklistStatus: "vorbereitung",
                picklistStatusNachricht: PICKLIST_STATUS_NACHRICHTEN.vorbereitung,
            };
    }
}
/* ──────────────────── Zusammenfassende Message ─────────────────────────── */
function formatMessage(order, shipments, shopLabel) {
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
async function picqerGet(endpoint, shop) {
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
    return resp.json();
}
/* ──────────────────────── Hilfsfunktionen ──────────────────────────────── */
function formatDate(dateStr) {
    if (!dateStr)
        return "";
    const d = new Date(dateStr.replace(" ", "T") + "Z");
    return d.toLocaleDateString("de-DE", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}
function formatDateShort(dateStr) {
    if (!dateStr)
        return "";
    const d = new Date(dateStr.replace(" ", "T") + "Z");
    return d.toLocaleDateString("de-DE", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
    });
}
