/* Recetario: listado, filtros y detalle de cada receta. */
(function () {
  var E = window.ESDLA, esc = E.esc;
  var RECETAS = window.RECETAS || [], SALSAS = window.SALSAS || [];
  var lista = document.getElementById("vista-lista");
  var detalle = document.getElementById("vista-receta");
  var grid = document.getElementById("grid-recetas");
  var filtros = document.getElementById("filtros");
  var tituloBase = document.title;

  // Filtros por salsa
  filtros.innerHTML = '<button class="filtro" type="button" data-filtro="">Todas</button>' +
    SALSAS.map(function (s) {
      return '<button class="filtro" type="button" data-color="' + esc(s.color) + '" data-filtro="' + esc(s.clave) + '">' + esc(s.nombre) + '</button>';
    }).join("");
  filtros.addEventListener("click", function (e) {
    var b = e.target.closest(".filtro");
    if (!b) return;
    var f = b.getAttribute("data-filtro");
    location.hash = f ? "salsa-" + f : "todas";
  });

  function pintarLista(filtro) {
    filtros.querySelectorAll(".filtro").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.getAttribute("data-filtro") === (filtro || "")));
    });
    var items = RECETAS.filter(function (r) { return !filtro || r.salsa === filtro; });
    grid.innerHTML = items.length
      ? items.map(function (r) { return E.recetaCard(r, "#" + r.slug); }).join("")
      : '<p class="recetario-vacio">Todavía no hay recetas con esta salsa. Muy pronto.</p>';
  }

  function pintarDetalle(r) {
    var s = E.salsa(r.salsa) || {};
    var ingredientes = r.ingredientes.map(function (g, gi) {
      return (g.grupo ? "<h3>" + esc(g.grupo) + "</h3>" : "") + "<ul>" +
        g.items.map(function (it, ii) {
          var id = "ing-" + gi + "-" + ii;
          return '<li><label for="' + id + '"><input type="checkbox" id="' + id + '"><span>' + esc(it) + "</span></label></li>";
        }).join("") + "</ul>";
    }).join("");
    var pasos = r.pasos.map(function (g) {
      return '<div class="pasos-grupo">' + (g.grupo ? "<h3>" + esc(g.grupo) + "</h3>" : "") + '<ol class="pasos">' +
        g.items.map(function (p) {
          return "<li><div>" + (p.t ? "<strong>" + esc(p.t) + "</strong>" : "") + "<p>" + esc(p.d) + "</p></div></li>";
        }).join("") + "</ol></div>";
    }).join("");
    var otras = RECETAS.filter(function (x) { return x.slug !== r.slug; }).slice(0, 3);

    detalle.innerHTML =
      '<article class="seccion" data-color="' + esc(s.color) + '"><div class="wrap">' +
        '<a class="receta-volver" href="#todas">' + E.icon.back + 'Todas las recetas</a>' +
        '<div class="receta-top">' + E.fotoReceta(r) +
          '<div>' +
            '<span class="ceja">Con ' + esc(s.nombreCompleto) + '</span>' +
            '<h1>' + esc(r.titulo) + '</h1>' +
            '<p class="receta-intro">' + esc(r.intro) + '</p>' +
            '<div class="receta-datos">' +
              '<div class="dato"><span>Porciones</span><strong>' + esc(r.porciones) + '</strong></div>' +
              '<div class="dato"><span>Preparación</span><strong>' + esc(r.preparacion) + '</strong></div>' +
              '<div class="dato"><span>Cocción</span><strong>' + esc(r.coccion || "Sin cocción") + '</strong></div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="receta-cuerpo">' +
          '<aside class="ingredientes"><h2>Ingredientes</h2>' + ingredientes +
            '<p class="ingredientes-tip">Tocá cada ingrediente para tacharlo mientras cocinás.</p></aside>' +
          '<div><h2>Procedimiento</h2>' + pasos +
            (r.nota ? '<div class="nota-abuela"><h3>La nota de la abuela</h3><p>' + esc(r.nota) + '</p></div>' : '') +
            '<div class="salsa-usada" data-color="' + esc(s.color) + '">' +
              '<div class="foto foto-petaca textura"><img src="' + esc(s.imagen) + '" alt="Petaca de ' + esc(s.nombreCompleto) + '"></div>' +
              '<div><span class="ceja">La salsa de esta receta</span><h3>' + esc(s.nombreCompleto) + '</h3>' +
                '<div class="acciones">' +
                  '<a class="btn btn-color" data-wa="¡Hola! Quiero pedir la ' + esc(s.nombreCompleto) + '." href="index.html#contacto">' + E.icon.chat + 'Pedila por WhatsApp</a>' +
                  '<a class="link-flecha" href="index.html#' + esc(s.clave) + '">Ver la salsa ' + E.icon.arrow + '</a>' +
                '</div></div>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div></article>' +
      (otras.length ? '<section class="seccion seccion-sin-arriba"><div class="wrap">' +
        '<div class="seccion-head"><span class="ceja">Seguí cocinando</span><h2>Más del recetario</h2></div>' +
        '<div class="recetas-grid">' + otras.map(function (x) { return E.recetaCard(x, "#" + x.slug); }).join("") + '</div>' +
      '</div></section>' : '');
    E.enlaces(detalle);
    document.title = r.titulo + " · El Secreto de la Abuela";
  }

  function ruta() {
    var h = decodeURIComponent(location.hash.replace(/^#/, ""));
    var receta = RECETAS.filter(function (r) { return r.slug === h; })[0];
    if (receta) {
      pintarDetalle(receta);
      lista.hidden = true; detalle.hidden = false;
      window.scrollTo(0, 0);
      return;
    }
    detalle.hidden = true; lista.hidden = false;
    document.title = tituloBase;
    var filtro = h.indexOf("salsa-") === 0 ? h.slice(6) : "";
    if (filtro && !E.salsa(filtro)) filtro = "";
    pintarLista(filtro);
  }

  window.addEventListener("hashchange", ruta);
  ruta();
  E.init();
})();
