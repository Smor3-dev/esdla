/* Funciones compartidas entre la home y el recetario */
(function () {
  var C = window.ESDLA_CONFIG || {};

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function salsa(clave) {
    return (window.SALSAS || []).filter(function (s) { return s.clave === clave; })[0];
  }

  function waLink(msg) {
    var num = String(C.whatsapp || "").replace(/\D/g, "");
    var base = num ? "https://wa.me/" + num : "https://wa.me/";
    return base + "?text=" + encodeURIComponent(msg || "¡Hola! Quiero hacer una consulta sobre las salsas de El Secreto de la Abuela.");
  }

  var icon = {
    chat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19.5 5.3 15.6A8 8 0 1 1 8.6 18.6Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M9.2 9.3c.3 1.9 1.6 3.4 3.6 4.2l1.2-1.1 1.8.9-.4 1.6c-3 .3-6.6-2.9-6.9-6l1.5-.6 1 1.7Z" fill="currentColor"/></svg>',
    mail: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5.5" width="18" height="13" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m4 7 8 6 8-6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
    at: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M15.6 12v1.4a2.4 2.4 0 0 0 4.8 0V12a8.4 8.4 0 1 0-3.3 6.7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    arrow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13m-5-5 5 5-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H6m5-5-5 5 5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 7.5V12l3 2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    plate: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="4.5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
    copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8.5" y="8.5" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>'
  };

  var selloN = 0;
  /* Sello circular "Receta n°" como el de las etiquetas */
  function sello(numero) {
    var id = "sello-" + (++selloN);
    return '<svg class="sello" viewBox="0 0 120 120" aria-hidden="true">' +
      '<defs><path id="' + id + '" d="M60 60m-43 0a43 43 0 1 1 86 0a43 43 0 1 1-86 0"/></defs>' +
      '<circle cx="60" cy="60" r="56" fill="none" stroke="currentColor" stroke-width="2"/>' +
      '<circle cx="60" cy="60" r="31" fill="none" stroke="currentColor" stroke-width="1.2"/>' +
      '<text class="sello-anillo"><textPath href="#' + id + '">EL SECRETO DE LA ABUELA · </textPath></text>' +
      '<text class="sello-chico" x="60" y="56" text-anchor="middle">Receta</text>' +
      '<text class="sello-num" x="60" y="74" text-anchor="middle">n°' + esc(numero) + '</text>' +
      '</svg>';
  }

  function fotoReceta(r) {
    var s = salsa(r.salsa) || {};
    if (r.foto) {
      return '<div class="foto foto-plato textura" data-color="' + esc(s.color) + '">' +
        '<img src="' + esc(r.foto) + '" alt="' + esc(r.titulo) + '" loading="lazy"></div>';
    }
    return '<div class="foto foto-petaca textura" data-color="' + esc(s.color) + '">' +
      '<img src="' + esc(s.imagen) + '" alt="" loading="lazy"></div>';
  }

  function tiempos(r) {
    var t = [];
    if (r.preparacion) t.push("Prep. " + r.preparacion);
    if (r.coccion) t.push("Cocción " + r.coccion);
    return t.join(" · ");
  }

  function recetaCard(r, href) {
    var s = salsa(r.salsa) || {};
    return '<a class="receta-card" data-color="' + esc(s.color) + '" href="' + esc(href) + '">' +
      fotoReceta(r) +
      '<div class="receta-card-body">' +
        '<span class="etiqueta-salsa">Con ' + esc(s.nombreCompleto || s.nombre) + '</span>' +
        '<h3>' + esc(r.titulo) + '</h3>' +
        '<p class="receta-meta">' + icon.plate + '<span>' + esc(r.porciones) + '</span></p>' +
        '<p class="receta-meta">' + icon.clock + '<span>' + esc(tiempos(r)) + '</span></p>' +
      '</div></a>';
  }

  function enlaces(root) {
    root = root || document;
    root.querySelectorAll("[data-wa]").forEach(function (a) {
      a.href = waLink(a.getAttribute("data-wa") || "");
      a.target = "_blank";
      a.rel = "noopener";
    });
    root.querySelectorAll("[data-ig]").forEach(function (a) {
      a.href = "https://www.instagram.com/" + (C.instagram || "") + "/";
      a.target = "_blank";
      a.rel = "noopener";
      if (!a.textContent.trim()) a.textContent = "@" + C.instagram;
    });
    root.querySelectorAll("[data-email]").forEach(function (el) {
      var partes = String(C.email || "").split("@");
      el.innerHTML = partes.length === 2 ? esc(partes[0]) + "<wbr>@" + esc(partes[1]) : esc(C.email);
    });
    root.querySelectorAll("[data-anio]").forEach(function (el) { el.textContent = new Date().getFullYear(); });
  }

  /* Lista de ingredientes en orden (de mayor a menor). Lo que va entre paréntesis
     se muestra como la función del aditivo: "Goma xántica (espesante)". */
  function listaIngredientes(items) {
    return '<p class="ing-nota">Ordenados de mayor a menor cantidad</p><ol class="ing-lista">' +
      (items || []).map(function (it) {
        var m = String(it).match(/^(.*?)\s*\((.+)\)$/);
        return m ? '<li>' + esc(m[1]) + ' <span class="ing-func">' + esc(m[2]) + '</span></li>' : '<li>' + esc(it) + '</li>';
      }).join("") + '</ol>';
  }

  function init() {
    enlaces(document);

    // Menú en celular
    var btn = document.querySelector(".menu-btn");
    var nav = document.querySelector(".nav");
    if (btn && nav) {
      btn.addEventListener("click", function () {
        var open = btn.getAttribute("aria-expanded") === "true";
        btn.setAttribute("aria-expanded", String(!open));
        nav.classList.toggle("abierto", !open);
      });
      nav.addEventListener("click", function (e) {
        if (e.target.closest("a")) {
          btn.setAttribute("aria-expanded", "false");
          nav.classList.remove("abierto");
        }
      });
    }
  }

  window.ESDLA = {
    esc: esc, salsa: salsa, waLink: waLink, icon: icon, sello: sello,
    fotoReceta: fotoReceta, recetaCard: recetaCard, tiempos: tiempos, init: init, enlaces: enlaces, listaIngredientes: listaIngredientes
  };
})();
