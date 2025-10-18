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

  En observacion, realiza un reporte detallado para que con eso un abogado sea capaz de tomar la desición si firmar o no el mandamiento, es importante que se detalle muy bien cada uno de los aspectos.

Texto:
"""
${texto}
"""`;

  const iaResponse = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek/deepseek-chat-v3.1:free",
        messages: [
          {
            role: "system",
            content: "Eres un abogado experto en cobro coactivo colombiano.",
          },
          { role: "user", content: prompt },
        ],
      }),
    }
  );

  const data = await iaResponse.json();
  if (data?.error) throw new Error(data.error.message || "Error en OpenRouter");

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

  const prompt = `
INSTRUCCIONES ESTRICTAS 
El texto que generes será pegado directamente en un documento legal.  
Por lo tanto:
- NO escribas introducciones, explicaciones ni mensajes al usuario.  
- NO uses frases como “a continuación”, “se procede a”, “el siguiente texto”, etc.  
- NO incluyas etiquetas, signos o marcas extrañas (como <comienzo del contenido>, </>, etc).  
- SOLO devuelve el contenido solicitado, limpio y en formato jurídico profesional.

---

### CASO 1: SEMÁFORO VERDE O AMARILLO

Siguiendo el artículo 826 del Estatuto Tributario Colombiano:

Genera el **texto completo y estructurado** de un **MANDAMIENTO DE PAGO** en formato legal colombiano.  
Debe tener tono **formal, jurídico y administrativo**, como un acto emitido por una entidad pública.

#### FORMATO Y ESTILO:
- Usa **títulos en mayúsculas y centrados** (ejemplo: “MANDAMIENTO DE PAGO”).  
- Usa subtítulos con # y ## para estructurar, pero **sin numeraciones (1., 2., etc.)**.  
- Usa **negritas** para destacar nombres, cargos o partes importantes.  
- NO uses listas Markdown ni enumeraciones de artículos (“ARTÍCULO PRIMERO”, etc.).  
- Escribe los párrafos directamente, en lenguaje jurídico fluido.  
- Evita frases repetitivas o genéricas.  
- Mantén un tono solemne, claro y conciso, como lo haría un abogado experto en cobro coactivo.

#### ESTRUCTURA EXACTA:
# MANDAMIENTO DE PAGO
**[Nombre de la entidad pública]**  
**[Lugar y fecha]**  
**[Número o radicado del expediente]**

## CONSIDERANDO
Expón brevemente:
- La competencia jurídica para el cobro coactivo (arts. 823 a 829 del Estatuto Tributario).  
- La existencia del título ejecutivo y su ejecutoria.  
- El monto adeudado y fundamento del cobro.

## RESUELVE QUE
Redacta párrafos que:
- Ordenen el pago de la obligación dentro del plazo legal (10 días hábiles).  
- Adviertan sobre el embargo y secuestro de bienes en caso de incumplimiento.  
- Indiquen que no procede recurso contra este acto.  

No uses “ARTÍCULO PRIMERO”, “SEGUNDO” ni numeraciones. Solo redacta los párrafos.

## FIRMA Y AUTORIZACIÓN
**[Nombre del funcionario competente]**  
**[Cargo]**  
Espacio para firma y sello institucional.

---

### CASO 2: SEMÁFORO ROJO

Genera el **texto completo de un DIAGNÓSTICO JURÍDICO** que explique las razones por las cuales el título ejecutivo **no es válido o no procede el cobro coactivo**.  
Debe estar escrito para que **un abogado pueda entender los fundamentos legales del rechazo o invalidez**, con tono formal, claro y técnico.

---

### DATOS DEL EXPEDIENTE
Usa la siguiente información en el texto, si aplica:
${datosTexto}

---

REGLAS FINALES:
- Solo genera el texto del documento.  
- No escribas nada fuera del cuerpo del acto.  
- No añadas marcas, comentarios o delimitadores.  
- Mantén una estructura limpia, con párrafos naturales, sin enumeraciones ni introducciones.
`;

  const iaResponse = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek/deepseek-chat-v3.1:free",
        messages: [
          {
            role: "system",
            content: "Eres un abogado profesional en procesos coactivos.",
          },
          { role: "user", content: prompt },
        ],
      }),
    }
  );

  const data = await iaResponse.json();
  if (data?.error) throw new Error(data.error.message || "Error en OpenRouter");

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

    if (textoLimpio.startsWith("# ")) {
      return new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 400 },
        children: [
          new TextRun({
            text: textoLimpio.replace(/^# /, ""),
            bold: true,
            size: 32,
            font: "Times New Roman",
          }),
        ],
      });
    }

    if (textoLimpio.startsWith("## ")) {
      return new Paragraph({
        alignment: AlignmentType.LEFT,
        spacing: { after: 300 },
        children: [
          new TextRun({
            text: textoLimpio.replace(/^## /, ""),
            bold: true,
            size: 28,
            font: "Times New Roman",
          }),
        ],
      });
    }

    const partes = textoLimpio.split(/\*\*(.*?)\*\*/g).map((t, i) =>
      i % 2 === 1
        ? new TextRun({
            text: t,
            bold: true,
            font: "Times New Roman",
            size: 28,
          })
        : new TextRun({ text: t, font: "Times New Roman", size: 28 })
    );

    return new Paragraph({
      children: partes,
      spacing: { after: 150 },
      alignment: AlignmentType.JUSTIFIED,
    });
  });

  const doc = new Document({
    creator: "Sistema Coactivo IA",
    title: `Mandamiento de Pago - Expediente ${expediente_id}`,
    sections: [{ children: contenido }],
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
