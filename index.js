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
  En el valor, busca el VALOR TOTAL de la deuda, analiza bien el texto... y en el semaforo devuelve: VERDE si es un titulo ejecutivo valido, AMARILLO si es un titulo ejecutivo con algun problema y ROJO si es un titulo ejecutivo NO VALIDO o PREESCRITO

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

ADVERTENCIA: EL CONTENIDO QUE GENERES SERÁ PEGADO EN UN DOCUMENTO ENTONCES, SOLO GENERA LO PEDIDO, NO AÑADAS TEXTO DE INTRODUCCION TUYO NI QUE VAS A REALIZAR LA TAREA, CUMPLE LO PEDIDO Y DEVUELVE EL TEXTO LIMPIO SIGUIENDO LAS INSTRUCCIONES.

En caso de que el semaforo sea VERDE u AMARILLO:
Siguiendo lo que dice el artículo 826 del Estatuto Tributario:
Genera el texto completo y estructurado de un MANDAMIENTO DE PAGO en formato legal colombiano.
Usa lenguaje jurídico formal, propio de actos administrativos, y estructura con títulos (#), subtítulos (##) y negritas (**texto**).

El documento debe incluir las siguientes secciones en este orden:

1. ENCABEZADO
   - Título principal en mayúsculas Y CENTRADO: MANDAMIENTO DE PAGO
   - Nombre de la entidad que emite el acto (por ejemplo: INSTITUTO DE DESARROLLO URBANO – IDU)
   - Lugar y fecha de expedición
   - Número o radicado del expediente
2. CONSIDERANDO
   - Explica brevemente la competencia jurídica para el cobro coactivo según los artículos 823 a 829 del Estatuto Tributario Nacional y demás normas aplicables.
   - Resume los hechos: la existencia del título ejecutivo, su ejecutoria, y el monto adeudado.
3. RESUELVE QUE
   - Ordena el pago de la obligación al deudor dentro del plazo legal (10 días hábiles).
   - Indica que en caso de incumplimiento se procederá con embargo y secuestro de bienes.
   - Menciona que contra este mandamiento no procede recurso, conforme al procedimiento coactivo.
4. FIRMA Y AUTORIZACIÓN
   - Nombre y cargo del funcionario competente que emite el acto.
   - Espacio para firma y sello institucional.
Usa un lenguaje jurídico claro y formal, propio de actos administrativos colombianos.
Cada sección debe comenzar con su respectivo título en mayúsculas.
Usa saltos de línea claros y evita listas o numeraciones Markdown.
Usa títulos (#), subtítulos (##) y negritas (**texto**) para dar formato como si fuese un documento WORD, pero solo devuelve texto plano con esas reglas.
Datos para usar en el documento:
Datos del expediente:
4. FIRMA Y AUTORIZACIÓN
Cada sección debe comenzar con su respectivo título en mayúsculas.
Usa saltos de línea claros y evita listas o numeraciones Markdown.
no pongas 1., 2... solo pon por ejemplo: CONSIDERANDO
Tambien: evita enumerar en el documento, los parrafos limpios por favor. dale un estilo formal al documento digno de un abogado de prestigio.

El documendo debe quedar algo como:

(LOS DATOS INICIALES)
...
CONSIDERANDO
parrafos de considerando...
RESUELVE QUE
parrafos de resuelve que...

EN CASO QUE EL SEMAFORO SEA ROJO:
GENERA EL TEXTO COMPLETO DE UN DIAGNOSTICO DE UN TITULO EJECUTIVO NO VALIDO POR CIERTOS MOTIVOS QUE DEBERÁS ANALIZAR Y DAR A ENTENDER A UN ABOGADO.

Datos del expediente:
${datosTexto}
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
