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
async function generarDocumentoIA(analisis, textoBase) {
  const prompt = `
Eres un abogado experto en cobro coactivo colombiano.
Siguiendo lo que dice el art 826 del estatuto tributario:

Genera el texto completo y estructurado de un MANDAMIENTO DE PAGO en formato legal colombiano, sin usar formato Markdown ni listas. Usa solo texto plano, con títulos en mayúsculas sostenidas y saltos de línea entre secciones.

El documento debe incluir las siguientes secciones en este orden:

1. ENCABEZADO
   - Título principal en mayúsculas: MANDAMIENTO DE PAGO
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

Usa títulos (#), subtítulos (##) y negritas (**texto**) para dar formato como si fuese un documento WORD, pero solo devuelve texto plano con esas reglas.
Datos para usar en el documento:
Datos del expediente:
${JSON.stringify(analisis, null, 2)}

Texto base del expediente:
"""
${textoBase}
"""
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

/* ---------------- SERVIDOR ---------------- */

app.listen(process.env.PORT || 3000, () =>
  console.log(`⚙️ Worker corriendo en puerto ${process.env.PORT || 3000}`)
);
