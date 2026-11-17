/* Home: fichas de productos, recetas destacadas, contacto y slider del banner. */
(function () {
  var E = window.ESDLA, C = window.ESDLA_CONFIG || {}, esc = E.esc;

  // ---------- Salsas ----------
  var html = (window.SALSAS || []).map(function (s) {
    var tieneRecetas = (window.RECETAS || []).some(function (r) { return r.salsa === s.clave; });
    var filas = s.nutricion.map(function (f) {
      return "<tr><td>" + esc(f[0]) + "</td><td>" + esc(f[1]) + "</td><td>" + esc(f[2]) + "</td></tr>";
    }).join("");
    // Tabla nutricional: si todavía no hay datos cargados, se muestra "Próximamente"
    var nutriPendiente = s.nutricion.every(function (f) { return f[1] === "—" && f[2] === "—"; });
    var nutriCuerpo = nutriPendiente
      ? '<p class="nutri-pronto">Estamos terminando de validar la información nutricional de esta salsa. Muy pronto vas a poder verla acá.</p>'
      : '<div class="tabla-scroll"><table class="tabla-nutri"><thead><tr><th scope="col">Nutriente</th><th scope="col">Por 100 g</th><th scope="col">Por porción</th></tr></thead><tbody>' + filas + '</tbody></table></div>' +
        '<p class="tabla-pie">Porción: 15 g (1 cucharada) · Porciones por envase: aprox. 13</p>';
    // Nivel de picante de 0 a 10
    var pic = Math.max(0, Math.min(10, s.picante || 0));
    var escala = "";
    for (var i = 1; i <= 10; i++) escala += '<span class="' + (i <= pic ? "on" : "") + '"></span>';
    var picante = '<div class="picor"><span class="va-bien-titulo">Picante</span>' +
      '<span class="picor-escala" role="img" aria-label="' + (pic ? "Picante " + pic + " de 10" : "Sin picante") + '">' + escala + '</span>' +
      '<span class="picor-valor">' + (pic ? pic + "/10" : "Sin picante") + '</span></div>';
    return '<article class="salsa" id="' + esc(s.clave) + '" data-color="' + esc(s.color) + '">' +
      '<div class="salsa-visual textura">' + E.sello(s.numero) +
        '<img src="' + esc(s.imagen) + '" alt="Petaca de ' + esc(s.nombreCompleto) + ' de 200 ml" width="484" height="900" loading="lazy">' +
      '</div>' +
      '<div class="salsa-info">' +
        '<span class="ceja">Receta n°' + esc(s.numero) + ' · 200 ml</span>' +
        '<h3><span class="salsa-prefijo">' + esc(s.prefijo) + '</span> ' + esc(s.nombre) + '</h3>' +
        '<p class="salsa-desc">' + esc(s.descripcion) + '</p>' +
        picante +
        '<div class="va-bien"><span class="va-bien-titulo">Va bien con</span><ul class="chips">' +
          s.vaBienCon.map(function (v) { return "<li>" + esc(v) + "</li>"; }).join("") +
        '</ul></div>' +
        '<div class="acordeon">' +
          '<details open><summary>La receta</summary><div class="acordeon-cuerpo">' + E.listaIngredientes(s.ingredientes) + '</div></details>' +
          '<details><summary><span>Información nutricional' + (nutriPendiente ? ' <span class="pronto">Próximamente</span>' : '') + '</span></summary><div class="acordeon-cuerpo">' +
            nutriCuerpo +
          '</div></details>' +
          '<details><summary>Las notas de la abuela</summary><div class="acordeon-cuerpo"><ul class="notas">' +
            s.notas.map(function (n) { return "<li>" + esc(n) + "</li>"; }).join("") +
            '<li>Contenido neto: 200 ml.</li>' +
          '</ul></div></details>' +
        '</div>' +
        '<div class="salsa-cta">' +
          '<button type="button" class="btn btn-color" data-comprar="' + esc(s.sku) + '" hidden>Comprar online</button>' +
          '<a class="btn btn-linea-color" data-wa="¡Hola! Quiero pedir la ' + esc(s.nombreCompleto) + '." href="#contacto">' + E.icon.chat + 'Pedila por WhatsApp</a>' +
          '<a class="link-flecha" data-ml-link="' + esc(s.sku) + '" hidden>Ver en Mercado Libre ' + E.icon.arrow + '</a>' +
          (tieneRecetas ? '<a class="link-flecha" href="recetario.html#salsa-' + esc(s.clave) + '">Recetas con esta salsa ' + E.icon.arrow + '</a>' : '') +
        '</div>' +
      '</div>' +
    '</article>';
  }).join("");
  document.getElementById("lista-salsas").innerHTML = html;
  document.getElementById("sello-mermelada").innerHTML = E.sello("004");
  document.getElementById("ing-mermelada").innerHTML = E.listaIngredientes(["Pulpa de pepino", "Azúcar", "Manzana rallada", "Jalapeño", "Vinagre de manzana", "Jugo de lima", "Jengibre", "Ralladura de lima"]);

  // ---------- Recetas destacadas ----------
  document.getElementById("recetas-destacadas").innerHTML = (window.RECETAS || []).slice(0, 3).map(function (r) {
    return E.recetaCard(r, "recetario.html#" + r.slug);
  }).join("");

  // ---------- Contacto ----------
  if (C.whatsapp) document.getElementById("wa-numero").textContent = C.whatsappVisible || ("+" + String(C.whatsapp).replace(/\D/g, ""));

  var copiar = document.getElementById("copiar-email");
  copiar.addEventListener("click", function () {
    var label = copiar.querySelector("span");
    var marcar = function () { label.textContent = "Copiado"; setTimeout(function () { label.textContent = "Copiar"; }, 1800); };
    var seleccionar = function () {
      var el = document.getElementById("email-texto");
      var range = document.createRange(); range.selectNodeContents(el);
      var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      label.textContent = "Seleccionado";
      setTimeout(function () { label.textContent = "Copiar"; }, 1800);
    };
    try {
      navigator.clipboard.writeText(C.email).then(marcar, seleccionar);
    } catch (e) { seleccionar(); }
  });

  var form = document.getElementById("form-contacto");
  var estado = document.getElementById("form-estado");
  var enviar = document.getElementById("f-enviar");
  function mostrar(tipo, texto) { estado.className = "form-estado " + tipo; estado.textContent = texto; estado.hidden = false; }

  form.addEventListener("input", function (e) { e.target.removeAttribute("aria-invalid"); });
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var campos = ["f-nombre", "f-email", "f-mensaje"].map(function (id) { return document.getElementById(id); });
    var malos = campos.filter(function (c) { return !c.value.trim() || !c.checkValidity(); });
    campos.forEach(function (c) { c.removeAttribute("aria-invalid"); });
    if (malos.length) {
      malos.forEach(function (c) { c.setAttribute("aria-invalid", "true"); });
      mostrar("error", "Completá tu nombre, un mail válido y el mensaje.");
      malos[0].focus();
      return;
    }
    var d = {
      nombre: form.nombre.value.trim(), email: form.email.value.trim(),
      telefono: form.telefono.value.trim(), motivo: form.motivo.value, mensaje: form.mensaje.value.trim()
    };
    enviar.disabled = true; enviar.textContent = "Enviando…";
    var datos = new URLSearchParams();
    new FormData(form).forEach(function (valor, clave) { datos.append(clave, String(valor)); });
    fetch("/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: datos.toString()
    }).then(function (r) {
      if (!r.ok) throw new Error(String(r.status));
      mostrar("ok", "¡Gracias, " + d.nombre + "! Recibimos tu mensaje y te respondemos a la brevedad.");
      form.reset();
    }).catch(function () {
      mostrar("error", "No pudimos enviar el mensaje. Probá de nuevo en un rato o escribinos por WhatsApp.");
    }).then(function () {
      enviar.disabled = false; enviar.textContent = "Enviar mensaje";
    });
  });

  // ---------- Slider del banner ----------
  (function () {
    var slides = Array.prototype.slice.call(document.querySelectorAll(".hero-slide"));
    var puntos = Array.prototype.slice.call(document.querySelectorAll(".hero-punto"));
    if (slides.length < 2) return;
    var actual = 0;
    function ir(i) {
      actual = (i + slides.length) % slides.length;
      slides.forEach(function (s, k) {
        var on = k === actual;
        s.classList.toggle("activa", on);
        s.inert = !on;
        if (on) s.removeAttribute("aria-hidden"); else s.setAttribute("aria-hidden", "true");
      });
      puntos.forEach(function (p, k) {
        p.setAttribute("aria-current", k === actual ? "true" : "false");
        p.classList.remove("corriendo");
      });
      void puntos[actual].offsetWidth; // reinicia la barrita de 5 s
      puntos[actual].classList.add("corriendo");
    }
    puntos.forEach(function (p, k) {
      p.addEventListener("click", function () { ir(k); });
      // el fin de la barrita (5 s) pasa a la siguiente; con "reducir movimiento" no avanza solo
      p.addEventListener("animationend", function () { if (k === actual) ir(actual + 1); });
    });
    ir(0);
  })();

  E.init();
})();
