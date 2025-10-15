import express from "express";
import mammoth from "mammoth";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";
import PDFParser from "pdf2json";
import { Document, Packer, Paragraph, HeadingLevel, TextRun } from "docx";

const app = express();
app.use(express.json());

// Conexión con Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

// Endpoint principal
app.post("/procesar", async (req, res) => {
  try {
    const { expediente_id, archivo_path, user_id } = req.body;
    console.log(`📂 Procesando expediente: ${expediente_id}`);
    console.log(`📄 Archivo: ${archivo_path}`);

    // Descargar archivo desde Supabase
    const { data, error } = await supabase.storage
      .from("expedientes")
      .download(archivo_path);
    if (error) throw error;
    console.log("✅ Archivo descargado correctamente desde Supabase");

    // Convertir a Buffer
    const arrayBuffer = await data.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    console.log(`✅ Archivo convertido a Buffer (${buffer.length} bytes)`);

    // Extraer texto
    const textoExtraido = await extraerTexto(buffer, archivo_path);
    console.log(
      `✅ Texto extraído correctamente (${textoExtraido.length} caracteres)`
    );

    // Primer llamado a la IA: análisis jurídico
    const analisis = await obtenerAnalisisIA(textoExtraido);
    console.log("✅ Análisis jurídico recibido de la IA:", analisis);

    // Actualizar Supabase con el resultado
    await actualizarExpediente(expediente_id, analisis);
    console.log(`✅ Expediente ${expediente_id} actualizado en Supabase`);

    // Segundo llamado a la IA: generación del documento legal
    const textoMandamiento = await generarDocumentoIA(analisis, textoExtraido);
    console.log("✅ Texto del documento generado por la IA");

    // Generar y subir el archivo DOCX a Supabase
    const docxBuffer = await generarDocxDesdeMarkdown(textoMandamiento);
    const docxUrl = await subirADirectorioSupabase(
      docxBuffer,
      user_id,
      expediente_id
    );

    console.log(`✅ Documento subido correctamente: ${docxUrl}`);
    res.json({ ok: true, analisis, docxUrl });
  } catch (err) {
    console.error("💥 Error general en worker:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ---------------- FUNCIONES AUXILIARES ---------------- */

// Extrae texto según el tipo de archivo
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

// Extraer texto desde PDF usando pdf2json
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

// Llamada a la IA para obtener el análisis jurídico estructurado (JSON)
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

// Actualiza Supabase con los datos analizados
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

// Llamada a la IA para generar el documento legal completo en formato markdown
async function generarDocumentoIA(texto, textoBase) {
  const datosTexto = formatearAnalisisComoTexto(analisis);

  const prompt = `
Eres un abogado experto en cobro coactivo colombiano.
Siguiendo lo que dice el artículo 826 del Estatuto Tributario:

Genera el texto completo y estructurado de un MANDAMIENTO DE PAGO en formato legal colombiano.
Usa lenguaje jurídico formal, propio de actos administrativos, y estructura con títulos (#), subtítulos (##) y negritas (**texto**).

El documento debe tener estas secciones:
1. ENCABEZADO
2. CONSIDERANDO
3. RESUELVE QUE
4. FIRMA Y AUTORIZACIÓN

Cada sección debe comenzar con su respectivo título en mayúsculas.
Usa saltos de línea claros y evita listas o numeraciones Markdown.

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

// Convierte texto markdown simple (#, ##, **texto**) a documento Word (.docx)
async function generarDocxDesdeMarkdown(texto) {
  const lineas = texto.split("\n");
  const doc = new Document();

  const contenido = lineas.map((linea) => {
    if (linea.startsWith("### ")) {
      return new Paragraph({
        text: linea.replace("### ", ""),
        heading: HeadingLevel.HEADING_3,
      });
    } else if (linea.startsWith("## ")) {
      return new Paragraph({
        text: linea.replace("## ", ""),
        heading: HeadingLevel.HEADING_2,
      });
    } else if (linea.startsWith("# ")) {
      return new Paragraph({
        text: linea.replace("# ", ""),
        heading: HeadingLevel.HEADING_1,
      });
    } else {
      const partes = linea
        .split(/\*\*(.*?)\*\*/g)
        .map((t, i) =>
          i % 2 === 1 ? new TextRun({ text: t, bold: true }) : new TextRun(t)
        );
      return new Paragraph({ children: partes });
    }
  });

  doc.addSection({ children: contenido });
  const buffer = await Packer.toBuffer(doc);
  return buffer;
}

// Sube el documento generado a Supabase Storage
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

  const { data } = supabase.storage.from("mandamientos").getPublicUrl(filePath);
  return data.publicUrl;
}

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

/* ---------------- SERVIDOR ---------------- */

app.listen(process.env.PORT || 3000, () =>
  console.log(`⚙️ Worker corriendo en puerto ${process.env.PORT || 3000}`)
);
