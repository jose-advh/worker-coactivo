import express from "express";
import mammoth from "mammoth";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";
import PDFParser from "pdf2json";
import { Document, Packer, Paragraph, TextRun, AlignmentType } from "docx";

const app = express();
app.use(express.json());

// Inicialización de Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

// Endpoint principal: procesa un expediente y genera el mandamiento
app.post("/procesar", async (req, res) => {
  try {
    const { expediente_id, archivo_path, user_id } = req.body;

    console.log(`Procesando expediente: ${expediente_id}`);
    console.log(`Archivo: ${archivo_path}`);

    // Descargar el archivo desde Supabase
    const { data, error } = await supabase.storage
      .from("expedientes")
      .download(archivo_path);
    if (error) throw error;

    // Convertir el archivo a Buffer
    const arrayBuffer = await data.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Extraer el texto según el tipo de archivo
    const textoExtraido = await extraerTexto(buffer, archivo_path);

    // Primer llamado a la IA: análisis jurídico
    const analisis = await obtenerAnalisisIA(textoExtraido);

    // Actualizar el expediente con el resultado del análisis
    await actualizarExpediente(expediente_id, analisis);

    // Segundo llamado a la IA: generación del documento legal
    const textoMandamiento = await generarDocumentoIA(analisis, textoExtraido);

    // Generar el archivo DOCX y subirlo a Supabase
    const docxBuffer = await generarDocxDesdeMarkdown(
      textoMandamiento,
      expediente_id,
      user_id
    );

    const docxUrl = await subirADirectorioSupabase(
      docxBuffer,
      user_id,
      expediente_id
    );

    console.log(`Documento subido correctamente: ${docxUrl}`);
    res.json({ ok: true, analisis, docxUrl });
  } catch (err) {
    console.error("Error general en worker:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ============================================================
   FUNCIONES AUXILIARES
============================================================ */

// Extrae el texto según la extensión del archivo
async function extraerTexto(buffer, archivo_path) {
  if (archivo_path.toLowerCase().endsWith(".pdf")) {
    return await extraerTextoPDF(buffer);
  } else if (archivo_path.toLowerCase().endsWith(".docx")) {
    const { value } = await mammoth.extractRawText({ buffer });
    return value;
  } else {
    throw new Error("Formato de archivo no soportado");
  }
}

// Extrae texto desde archivos PDF usando pdf2json
async function extraerTextoPDF(buffer) {
  return new Promise((resolve, reject) => {
    const pdfParser = new PDFParser();

    pdfParser.on("pdfParser_dataError", (errData) =>
      reject(errData.parserError)
    );

    pdfParser.on("pdfParser_dataReady", (pdfData) => {
      try {
        const texto = pdfData.Pages.map((page) =>
          page.Texts.map((t) => decodeURIComponent(t.R[0].T)).join(" ")
        ).join("\n");
        resolve(texto);
      } catch (e) {
        reject(e);
      }
    });

    pdfParser.parseBuffer(buffer);
  });
}

// Llamado a la IA para obtener un análisis jurídico estructurado (JSON)
async function obtenerAnalisisIA(texto) {
  const prompt = `
  Eres un abogado experto en cobro coactivo colombiano.
  Analiza el siguiente texto y devuelve únicamente un objeto JSON con esta estructura:
  {
    "nombre": "",
    "entidad": "",
    "valor": "",
    "fecha_resolucion": "",
    "fecha_ejecutoria": "",
    "tipo_titulo": "",
    "semaforo": "",
    "observacion": ""
  }

  Por favor, devuelve tal cual con los nombres y dentro de los parentesis el texto.
  En el valor, busca el VALOR TOTAL de la deuda y ese valor, ponlo en "valor": "".. Es decir, con los intereses debidos. Tambien: analiza bien el texto... y en el semaforo devuelve: VERDE si es un titulo ejecutivo valido, AMARILLO si es un titulo ejecutivo con algun problema y ROJO si es un titulo ejecutivo NO VALIDO o PREESCRITO

  EJEMPLO: "semaforo": "VERDE",
  EL TEXTO TAL CUAL.

  En observacion, realiza un reporte detallado para que con eso un abogado sea capaz de tomar la desición si firmar o no el mandamiento, es importante que se detalle muy bien cada uno de los aspectos y agrega la ciudad del documento.

Texto:
"""
${texto}
"""`;

  const iaResponse = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, // Mantiene la misma variable
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-5", // Cambiado a modelo oficial de OpenAI
      messages: [
        {
          role: "system",
          content: "Eres un abogado experto en cobro coactivo colombiano.",
        },
        { role: "user", content: prompt },
      ],
    }),
  });

  const data = await iaResponse.json();

  if (!iaResponse.ok) {
    console.error("Error de OpenAI:", data);
    throw new Error(data.error?.message || "Error en la API de OpenAI");
  }

  const textoIA = data?.choices?.[0]?.message?.content?.trim() || "{}";
  const limpio = textoIA
    .replace(/```json|```/g, "")
    .replace(/[^\{]*({[\s\S]*})[^\}]*$/, "$1")
    .trim();

  try {
    return JSON.parse(limpio);
  } catch {
    throw new Error("Error al parsear respuesta de la IA");
  }
}

// Actualiza la tabla "expedientes" con los datos analizados
async function actualizarExpediente(expediente_id, json) {
  const { error } = await supabase
    .from("expedientes")
    .update({
      titulo: json.tipo_titulo || "",
      semaforo: json.semaforo || "ROJO",
      observaciones: json.observacion || "",
    })
    .eq("id", expediente_id);

  if (error) throw error;
}

// Llamado a la IA para generar el texto del documento legal
async function generarDocumentoIA(analisis, textoBase) {
  const datosTexto = formatearAnalisisComoTexto(analisis);

  // Detectar el tipo de semáforo
  const semaforo = (analisis.semaforo || "").toUpperCase();

  // Prompt base
  let prompt = "";
  let modelo = "gpt-5";

  if (semaforo === "VERDE" || semaforo === "AMARILLO") {
    // === Caso Mandamiento de Pago ===
    prompt = `
Eres un abogado experto en cobro coactivo colombiano.

Siguiendo el artículo 826 del Estatuto Tributario Colombiano, redacta el **texto completo y estructurado** de un MANDAMIENTO DE PAGO No. ___ en formato legal colombiano.

Debe tener tono formal, jurídico y administrativo, como un acto emitido por una entidad pública.

#### FORMATO Y ESTILO:
- El título principal debe ir centrado, en mayúsculas y negrita: “MANDAMIENTO DE PAGO No. MP-FechaHoy”. --- Debes cambiar fecha hoy por la fecha del dia de hoy
- Usa subtítulos con # y ## 
- Utiliza negritas para nombres, cargos, entidades y referencias legales importantes.
- Usa lenguaje jurídico claro, preciso y solemne.
- Evita frases genéricas o redundantes.
- El resultado debe parecer un **acto administrativo oficial listo para imprimirse en Word**.

#### ESTRUCTURA EXACTA:

# MANDAMIENTO DE PAGO No. ___
**[Nombre de la entidad pública]**  
**[Lugar y fecha]**  
**[Número o radicado del expediente]**

## ANTECEDENTES (CENTRADO)
Redacta un párrafo introductorio con esta fórmula:
“Que mediante **Certificado de Estado de Cuenta N°____, expedido por la Subdirección Financiera del ..., se determinó la obligación a cargo de [nombre del deudor].”

## CONSIDERANDO (CENTRADO)
Expón detalladamente:
Lenguaje formal y jurídico-administrativo.

Estructura numerada (“1. Que…”, “2. Que…”, etc.).

Incluir las bases normativas: Estatuto Tributario Nacional (artículos 828, 837, 838, 839-1), Código General del Proceso (artículo 466) y Ley 1066 de 2006.

Mencionar los datos del deudor o sociedad, el número de certificado, el valor de la deuda, el CHIP y la matrícula inmobiliaria.

Concluir con la expresión: “En mérito de lo expuesto la abogada ejecutora,”.

## RESUELVE QUE
Redacta detalladamente la parte resolutiva de un Mandamiento de Pago dentro de un proceso administrativo de cobro coactivo, siguiendo el formato jurídico oficial colombiano.
Estructura el texto en numerales (PRIMERO, SEGUNDO, TERCERO...) donde se ordene:
La expedición del mandamiento de pago (art. 826 E.T.N.), indicando el valor de la deuda, intereses, CHIP, matrícula inmobiliaria, dirección y nombre del deudor.
El embargo de cuentas bancarias y valores (art. 838 E.T.N.).
El embargo y secuestro del inmueble involucrado.
La orden de librar los oficios correspondientes.
La notificación personal del mandamiento (arts. 826 y 568 E.T.N.).
La advertencia del plazo de 15 días para pagar o presentar excepciones (arts. 830 y 831 E.T.N.).
La indicación de que no procede recurso alguno (art. 833-1 E.T.N.).
Usa lenguaje formal, jurídico-administrativo, claro y conciso, coherente con los actos administrativos del IDU.

---

## FIRMA Y AUTORIZACIÓN
**[Nombre del funcionario competente]**  
**[Cargo]**  
(Espacio para firma y sello institucional)

---

## NOTIFICACIÓN
“debes poner algo por ejemplo: Notifíquese personalmente al deudor conforme al **artículo 68 del CPACA** y **artículo 826 del Estatuto Tributario**.”

Al final del documento debes poner:
Dado en [ciudad]., a los dias [dias] del mes de [mes] de [año]
Dr. [Nombre del Abogado ejecutor] --- Si no encuentras nombre del abogado en los datos del expediente, deja tal cual [nombre del abogado ejecutor]
Tarjeta Profesional No. [numero] --- Si no encuentras el numero de tarjeta en los datos del expediente, deja tal cual [numero]
Entidad: [nombre de la entidad]


#### DATOS DEL EXPEDIENTE
${datosTexto}

Solo devuelve el texto del documento, limpio, sin comentarios ni explicaciones.`;
  } else if (semaforo === "ROJO") {
    // === Caso Diagnóstico Jurídico ===
    prompt = `
Eres un abogado experto en cobro coactivo colombiano.

Genera el **texto completo de un DIAGNÓSTICO JURÍDICO** sobre un expediente cuyo título ejecutivo **no es válido o no procede para cobro coactivo**.

Debe estar redactado con tono **jurídico formal, técnico y analítico**, orientado a que un abogado pueda entender **por qué el título fue marcado con semáforo ROJO**.

#### ESTRUCTURA Y CONTENIDO:
# DIAGNÓSTICO JURÍDICO
**[Entidad analizada]**  
**[Fecha del informe]**  
**[Número o radicado del expediente]**

## ANÁLISIS JURÍDICO
Explica de forma razonada:
- Las razones por las cuales el título **no constituye título ejecutivo válido** (por ejemplo, falta de ejecutoria, prescripción, error en la resolución, falta de claridad en la obligación, vicios de forma o fondo).
- Si el documento presenta **omisiones, inconsistencias o errores** que impidan iniciar cobro coactivo.
- Fundamenta con base en normas del **Estatuto Tributario Colombiano** y la **jurisprudencia aplicable**.

## CONCLUSIÓN
Redacta un párrafo que resuma **por qué el expediente no puede avanzar al mandamiento de pago** y qué **acciones correctivas o revisiones** se recomiendan (por ejemplo: verificar prescripción, corregir valores, obtener nueva resolución, etc.).

#### DATOS DEL EXPEDIENTE
${datosTexto}

Solo devuelve el texto limpio, sin explicaciones adicionales, sin listas ni enumeraciones.`;
  } else {
    throw new Error(`Semáforo no válido o no reconocido: ${semaforo}`);
  }

  // Llamado a OpenRouter con el prompt elegido
  const iaResponse = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: modelo,
      messages: [
        {
          role: "system",
          content: "Eres un abogado profesional en procesos coactivos.",
        },
        { role: "user", content: prompt },
      ],
    }),
  });

  // Manejo de respuesta
  const data = await iaResponse.json();

  if (data?.error) {
    throw new Error(data.error.message || "Error en OpenAI");
  }

  return data?.choices?.[0]?.message?.content?.trim() || "";
}

// Convierte texto Markdown simple a documento Word (.docx)
async function generarDocxDesdeMarkdown(texto, expediente_id, user_id) {
  const lineas = texto.split("\n");

  const contenido = lineas.map((linea) => {
    const textoLimpio = linea.trim();
    if (!textoLimpio) {
      return new Paragraph({ text: "" });
    }

    // Título principal (#)
    if (textoLimpio.startsWith("# ")) {
      return new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 200, line: 240 }, // sin interlineado
        children: [
          new TextRun({
            text: textoLimpio.replace(/^# /, ""),
            bold: true,
            size: 23, // 11.5 pt → *2 = 23*
            font: "Arial",
          }),
        ],
      });
    }

    // Subtítulo (##)
    if (textoLimpio.startsWith("## ")) {
      return new Paragraph({
        alignment: AlignmentType.LEFT,
        spacing: { after: 150, line: 240 }, // sin interlineado
        children: [
          new TextRun({
            text: textoLimpio.replace(/^## /, ""),
            bold: true,
            size: 23, // 11.5 pt
            font: "Arial",
          }),
        ],
      });
    }

    // Párrafos normales con soporte para **negritas**
    const partes = textoLimpio.split(/\*\*(.*?)\*\*/g).map((t, i) =>
      i % 2 === 1
        ? new TextRun({
            text: t,
            bold: true,
            font: "Arial",
            size: 23,
          })
        : new TextRun({
            text: t,
            font: "Arial",
            size: 23,
          })
    );

    return new Paragraph({
      children: partes,
      alignment: AlignmentType.JUSTIFIED,
      spacing: { after: 100, line: 240 }, // sin interlineado
    });
  });

  const doc = new Document({
    creator: "Sistema Coactivo IA",
    title: `Mandamiento de Pago - Expediente ${expediente_id}`,
    sections: [
      {
        properties: {
          page: {
            margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }, // 2.5 cm
          },
        },
        headers: {},
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({
                    text: "Este documento está suscrito con firma mecánica autorizada mediante Resolución No. 400 de marzo 11 de 2021.   ",
                    font: "Arial",
                    size: 17, // 8.5 pt
                  }),
                  new TextRun({
                    children: [PageNumber.CURRENT],
                    font: "Arial",
                    size: 17,
                  }),
                ],
              }),
            ],
          }),
        },
        children: contenido,
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  return buffer;
}

// Sube el documento al Storage y actualiza el mandamiento_path en el expediente
async function subirADirectorioSupabase(buffer, user_id, expediente_id) {
  const filePath = `mandamientos/${user_id}/mandamiento_${expediente_id}.docx`;

  const { error } = await supabase.storage
    .from("mandamientos")
    .upload(filePath, buffer, {
      contentType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      upsert: true,
    });

  if (error) throw error;

  // Obtiene la URL pública
  const { data } = supabase.storage.from("mandamientos").getPublicUrl(filePath);
  const publicUrl = data.publicUrl;

  // Actualiza el campo mandamiento_path en la tabla "expedientes"
  const { error: updateError } = await supabase
    .from("expedientes")
    .update({ mandamiento_path: filePath })
    .eq("id", expediente_id);

  if (updateError) throw updateError;

  console.log(`mandamiento_path actualizado para expediente ${expediente_id}`);

  return publicUrl;
}

// Formatea los datos del análisis para incluirlos en el documento
function formatearAnalisisComoTexto(analisis) {
  return `
Nombre del deudor: ${analisis.nombre || "No disponible"}
Entidad: ${analisis.entidad || "No disponible"}
Valor total: ${analisis.valor || "No disponible"}
Fecha de resolución: ${analisis.fecha_resolucion || "No disponible"}
Fecha de ejecutoria: ${analisis.fecha_ejecutoria || "No disponible"}
Tipo de título: ${analisis.tipo_titulo || "No disponible"}
Semáforo: ${analisis.semaforo || "No disponible"}
Observación: ${analisis.observacion || "No disponible"}
  `.trim();
}

/* ============================================================
   INICIO DEL SERVIDOR
============================================================ */

app.listen(process.env.PORT || 3000, () => {
  console.log(`Worker corriendo en puerto ${process.env.PORT || 3000}`);
});
