/*
 * Página de regreso desde Mercado Pago. No confía en el "estado" que viene en la URL:
 * consulta al servidor, que solo marca "pagado" cuando Mercado Pago lo confirma por
 * webhook (o por consulta directa a su API).
 */
(function () {
  var E = window.ESDLA;
  var params = new URLSearchParams(window.location.search);
  var ref = params.get("external_reference") || "";
  try { if (!ref) ref = sessionStorage.getItem("esdla_ref") || ""; } catch (e) { /* bloqueado */ }

  var titulo = document.getElementById("g-titulo");
  var texto = document.getElementById("g-texto");
  var wa = document.getElementById("g-wa");
  function poner(t, d) { titulo.textContent = t; texto.textContent = d; }

  E.init();
  if (!/^W-[0-9A-HJKMNP-TV-Z]{26}$/.test(ref)) {
    poner("No encontramos tu compra", "Si pagaste, escribinos por WhatsApp y lo revisamos al toque.");
    wa.hidden = false;
    return;
  }

  var intentos = 0;
  function consultar() {
    intentos++;
    fetch("/api/orders/status?ref=" + encodeURIComponent(ref), { credentials: "same-origin", cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : { status: "desconocido" }; })
      .then(function (d) {
        if (d.status === "paid") {
          poner("¡Gracias por tu compra!", "Tu pago está aprobado. Te escribimos por WhatsApp para coordinar la entrega.");
          wa.hidden = false;
          try { sessionStorage.removeItem("esdla_ref"); } catch (e) { /* nada */ }
          return;
        }
        if (d.status === "canceled" || d.status === "expired" || d.status === "failed") {
          poner("El pago no se completó", "No se te cobró nada. Podés intentarlo de nuevo desde la tienda.");
          return;
        }
        if (intentos < 40) { setTimeout(consultar, 3000); return; }
        poner("Tu pago está en proceso", "Mercado Pago todavía no lo confirmó. Apenas se acredite te avisamos por WhatsApp.");
        wa.hidden = false;
      })
      .catch(function () { if (intentos < 40) setTimeout(consultar, 3000); });
  }
  consultar();
})();
