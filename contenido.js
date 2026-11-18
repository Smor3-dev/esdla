/* ==========================================================
   CONTENIDO DE LA WEB — El Secreto de la Abuela
   Todo lo que se muestra en la web sale de este archivo.
   Para sumar una receta: copiá un bloque de RECETAS, cambiá
   los textos y poné la foto del plato en img/ (ej: img/mi-plato.jpg).
   ========================================================== */

window.ESDLA_CONFIG = {
  // Número de WhatsApp con código de país, sin "+", espacios ni guiones. Ej: "59899123456"
  whatsapp: "59899501132",
  whatsappVisible: "099 501 132",
  email: "elsecretodelaabuela.uy@gmail.com",
  instagram: "esdla.uy",
  // El formulario de contacto usa Netlify Forms: llega al mail que configures en
  // Netlify → Forms → Form notifications. No hace falta ningún servicio externo.
  formEndpoint: "netlify"
};

/* Filas de la tabla nutricional (mismo orden que la contraetiqueta).
   Cada fila: [nutriente, por 100 g, por porción]. "—" = falta cargar. */
function filasNutricionales(v) {
  v = v || {};
  var f = function (k) { return v[k] || ["—", "—"]; };
  return [
    ["Valor energético"].concat(f("energia")),
    ["Carbohidratos"].concat(f("carbohidratos")),
    ["Azúcares totales"].concat(f("azucares")),
    ["Azúcares añadidos"].concat(f("azucaresAnadidos")),
    ["Proteínas"].concat(f("proteinas")),
    ["Grasas totales"].concat(f("grasas")),
    ["Grasas saturadas"].concat(f("saturadas")),
    ["Grasas trans"].concat(f("trans")),
    ["Fibra alimentaria"].concat(f("fibra")),
    ["Sodio"].concat(f("sodio"))
  ];
}

var NOTAS_ABUELA = [
  "Conservar en lugar fresco y seco.",
  "Una vez abierta, mantener refrigerada entre 2 °C y 5 °C y consumir preferentemente dentro de los 60 días.",
  "Agitar antes de usar."
];

window.SALSAS = [
  {
    clave: "morron-zanahoria",
    sku: "ZYM-200",
    numero: "001",
    nombre: "Zanahoria & Morrón",
    prefijo: "Salsa de",
    nombreCompleto: "Salsa de Zanahoria & Morrón",
    picante: 0, // de 0 a 10
    color: "naranja",
    imagen: "img/petaca-zanahoria-morron.webp",
    descripcion: "Salsa de zanahoria con morrón asado, miel y ajo. Ideal para carnes rojas, aunque vaya bien con todo.",
    vaBienCon: ["Carnes rojas", "Entraña", "Hamburguesas", "Choripán"],
    // De mayor a menor cantidad (planilla ESDLA_ingredientes)
    ingredientes: ["Agua", "Morrón", "Zanahoria", "Vinagre de manzana", "Cebolla", "Miel", "Aceite", "Vinagre de alcohol", "Sal", "Ácido cítrico (acidulante)", "Ajo", "Goma xántica (espesante)", "Sorbato de potasio (conservante)", "Benzoato de sodio (conservante)"],
    nutricion: filasNutricionales(),
    notas: NOTAS_ABUELA
  },
  {
    clave: "sweet-jalapeno",
    sku: "SWJ-200",
    numero: "002",
    nombre: "Sweet Jalapeño",
    prefijo: "Salsa",
    nombreCompleto: "Salsa Sweet Jalapeño",
    picante: 3, // de 0 a 10
    color: "rojo",
    imagen: "img/petaca-sweet-jalapeno.webp",
    descripcion: "Salsa agridulce de tomate, miel y jalapeño, levemente picante. Perfecta para preparaciones intensas.",
    vaBienCon: ["Cerdo", "Glaseados", "Carnes al horno", "Tacos"],
    // De mayor a menor cantidad (planilla ESDLA_ingredientes)
    ingredientes: ["Tomate triturado", "Azúcar", "Agua", "Vinagre de manzana", "Salsa de tomate", "Miel", "Jalapeño", "Sal", "Ácido cítrico (acidulante)", "Goma xántica (espesante)", "Sorbato de potasio (conservante)", "Benzoato de sodio (conservante)"],
    nutricion: filasNutricionales(),
    notas: NOTAS_ABUELA
  },
  {
    clave: "verde-de-huerta",
    sku: "VDH-200",
    numero: "003",
    nombre: "Verde de Huerta",
    prefijo: "Salsa",
    nombreCompleto: "Salsa Verde de Huerta",
    picante: 0, // de 0 a 10
    color: "verde",
    imagen: "img/petaca-verde-de-huerta.webp",
    descripcion: "Salsa con base de pepino, manzana, cilantro, lima y ajo. Un blend de verdes aromáticos para preparaciones frescas.",
    vaBienCon: ["Ensaladas", "Pescados", "Sándwiches", "Bowls"],
    // De mayor a menor cantidad (planilla ESDLA_ingredientes)
    ingredientes: ["Pepino", "Manzana", "Agua", "Aceite neutro", "Lima", "Vinagre de manzana", "Cilantro", "Sal", "Ajo", "Goma xántica (espesante)", "Sorbato de potasio (conservante)", "Benzoato de sodio (conservante)"],
    nutricion: filasNutricionales(),
    notas: NOTAS_ABUELA
  }
];

/* ==========================================================
   RECETARIO — las más nuevas van arriba
   foto: "" muestra la petaca de la salsa hasta que haya foto del plato
   ========================================================== */
window.RECETAS = [
  {
    slug: "entrana-morron-zanahoria",
    titulo: "Entraña en sartén con Salsa de Zanahoria & Morrón",
    salsa: "morron-zanahoria",
    foto: "img/plato-entrana.webp",
    intro: "Entraña bien sellada, cherrys y ajos confitados, champiñones y una base generosa de Salsa de Zanahoria & Morrón. Un plato de restaurante hecho en una sartén.",
    porciones: "2 personas",
    preparacion: "20 min",
    coccion: "30 min",
    ingredientes: [
      { grupo: "", items: [
        "400–450 g de entraña de vacuno",
        "80–100 g de Salsa de Zanahoria & Morrón El Secreto de la Abuela",
        "1 cucharada de aceite neutro o de oliva (aprox. 15 ml)",
        "25 g de manteca",
        "2 ramitas de tomillo o romero fresco",
        "Sal fina, pimienta negra y escamas de sal a gusto"
      ]},
      { grupo: "Para los cherry y los ajos confitados", items: [
        "250 g de tomates cherry",
        "8 dientes de ajo, pelados",
        "120 ml de aceite de oliva",
        "1 ramita de tomillo o romero"
      ]},
      { grupo: "Champiñones salteados", items: [
        "100 g de champiñones",
        "Aceite para saltear",
        "Sal y pimienta a gusto"
      ]}
    ],
    pasos: [
      { grupo: "", items: [
        { t: "Confitar los cherry y los ajos", d: "Colocar los 8 dientes de ajo y los 250 g de cherrys en aceite de oliva con una ramita de hierbas en una sartén pequeña. Cocinar a fuego mínimo durante 20–25 minutos, sin dejar que el aceite hierva fuerte, hasta que estén tiernos y apenas dorados. Reservar en el aceite." },
        { t: "Saltear los champiñones", d: "En una sartén con un chorrito de aceite, saltear los hongos unos minutos hasta que estén tiernos. Salpimentar y reservar." },
        { t: "Preparar la entraña", d: "Retirar la carne de la heladera 20–30 minutos antes de cocinar. Quitar la membrana gruesa si todavía la tiene, secarla muy bien con papel, rociarla con un hilo de aceite y condimentar con sal y pimienta." },
        { t: "Calentar la sartén", d: "Calentar la sartén hasta que esté bien caliente. Usar el truco del agua para corroborar." },
        { t: "Sellar el primer lado", d: "Con la sartén bien caliente y sin aceite, colocar la entraña sin moverla y cocinar durante 3–4 minutos, hasta formar una costra dorada." },
        { t: "Cocinar el segundo lado", d: "Dar vuelta y cocinar 2–3 minutos. En el último minuto, agregar la manteca y el tomillo." },
        { t: "Bañar la carne", d: "Inclinar apenas la sartén y, con una cuchara, bañar la entraña con la manteca." },
        { t: "Controlar el punto", d: "Retirar la carne cuando el centro alcance 52–54 °C para obtener un punto rosado después del reposo. Dejar descansar 5–7 minutos." },
        { t: "Calentar la salsa (opcional)", d: "Entibiar la Salsa de Zanahoria & Morrón a fuego muy bajo o a baño María. Evitar que hierva para conservar su textura y color." },
        { t: "Cortar y emplatar", d: "Cortar la entraña en tiras de 1,5–2 cm. Hacer una base generosa de salsa en el plato y acomodar 4–5 cortes de entraña. Sumar los champiñones salteados, los cherry y los ajos confitados." }
      ]}
    ],
    nota: ""
  },
  {
    slug: "bondiola-sweet-jalapeno",
    titulo: "Bondiola glaseada con Salsa Sweet Jalapeño",
    salsa: "sweet-jalapeno",
    foto: "img/plato-bondiola.webp",
    intro: "Bondiola al horno con un glaseado de Salsa Sweet Jalapeño, servida sobre puré de boniato.",
    porciones: "2 personas",
    preparacion: "25 min + marinado",
    coccion: "45–60 min",
    ingredientes: [
      { grupo: "", items: [
        "600 g de bondiola de cerdo",
        "120 g de Salsa Sweet Jalapeño El Secreto de la Abuela",
        "1 diente de ajo, picado fino",
        "1 rama de romero fresco o seco (aprox. 3 g)",
        "1 cucharada de manteca",
        "Sal fina y pimienta negra a gusto"
      ]},
      { grupo: "Para el marinado", items: [
        "Salsa inglesa",
        "Salsa de soja",
        "Un chorrito de aceite"
      ]},
      { grupo: "Para el puré", items: [
        "700 g de boniato, pelado y cortado en cubos",
        "30 g de manteca"
      ]}
    ],
    pasos: [
      { grupo: "", items: [
        { t: "Marinar la bondiola", d: "Mezclar el ajo picado, el romero, la salsa inglesa, la salsa de soja, sal, pimienta y un chorrito de aceite. Untar la carne, tapar y dejar en la heladera al menos 1 hora; idealmente, toda la noche." },
        { t: "Preparar el horno", d: "Precalentar a 180 °C. Retirar la bondiola de la heladera 15 minutos antes de cocinarla." },
        { t: "Sellar la carne", d: "Calentar una sartén a fuego medio-alto y dorar la bondiola con manteca y romero por todas sus caras durante 8–10 minutos." },
        { t: "Hornear", d: "Pasar la bondiola a una fuente y hornear durante 30–45 minutos, según el grosor de la pieza." },
        { t: "Hacer el puré", d: "Hervir el boniato durante 20–25 minutos o hasta que esté muy tierno. Escurrirlo y dejarlo evaporar 1 minuto. Pisar con la manteca y ajustar sal y pimienta." },
        { t: "Glasear", d: "Durante los últimos 15 minutos de horno, retirar la bondiola y pincelarla con Salsa Sweet Jalapeño." },
        { t: "Controlar y reposar", d: "Retirar la carne cuando el centro alcance 63–68 °C. Dejar reposar 8–10 minutos antes de cortarla en medallones." },
        { t: "Emplatar", d: "Servir una base de puré, acomodar encima la bondiola y terminar con un poco más de Salsa Sweet Jalapeño." }
      ]}
    ],
    nota: ""
  },
  {
    slug: "ensalada-verde-de-huerta",
    titulo: "Ensalada con Salsa Verde de Huerta",
    salsa: "verde-de-huerta",
    foto: "img/plato-ensalada.webp",
    intro: "Hojas verdes, manzana, dambo y nueces tostadas sobre una base de Salsa Verde de Huerta, que hace de aderezo. Lista en 15 minutos.",
    porciones: "2 personas",
    preparacion: "15 min",
    coccion: "",
    ingredientes: [
      { grupo: "", items: [
        "2 tazas de rúcula (40 g)",
        "2 tazas de radicheta o kale (50 g)",
        "1 tallo de apio (40 g)",
        "10 tomates cherry (150 g)",
        "½ manzana verde (90 g)",
        "Queso dambo en cubos (80 g)",
        "Nueces (30 g)",
        "Salsa Verde de Huerta (60 g aprox.)",
        "Aceite (10 ml)",
        "Sal a gusto"
      ]}
    ],
    pasos: [
      { grupo: "Preparación", items: [
        { t: "", d: "Lavar y desinfectar todos los vegetales con agua y vinagre de alcohol en proporción 10:1. Enjuagar bien y secar." },
        { t: "", d: "En un bowl, colocar la rúcula y la radicheta o kale. Agregar 10 ml de aceite y sal a gusto, y mezclar suavemente." },
        { t: "", d: "Cortar los tomates cherry a la mitad. Cortar la manzana y el queso dambo en cubos de aproximadamente 1 × 1 cm, y el apio en rodajas bien finas." },
        { t: "", d: "Tostar las nueces en una sartén a fuego medio durante 2 a 3 minutos, moviéndolas constantemente para que no se quemen. No hace falta aceite ni manteca." }
      ]},
      { grupo: "Emplatado", items: [
        { t: "", d: "Colocar en el centro del plato una base generosa de Salsa Verde de Huerta." },
        { t: "", d: "Sobre la salsa, formar un colchón con la mezcla de rúcula, radicheta y kale." },
        { t: "", d: "Distribuir por encima la manzana, el apio y el queso dambo." },
        { t: "", d: "Agregar los tomates cherry alrededor y entre los demás ingredientes para sumar color." },
        { t: "", d: "Por último, picar ligeramente las nueces tostadas y esparcirlas sobre la ensalada." }
      ]}
    ],
    nota: "No hace falta agregar aceite ni vinagre extra: la Salsa Verde de Huerta funciona como aderezo de la ensalada."
  }
];
