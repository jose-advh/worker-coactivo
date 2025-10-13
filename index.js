import express from "express";
import mammoth from "mammoth";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";
import PDFParser from "pdf2json";

const app = express();
app.use(express.json());

// Conexión Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

app.post("/procesar", async (req, res) => {
  try {
    const { expediente_id, archivo_path } = req.body;
    console.log(`Procesando expediente ${expediente_id}`);

    // Descargar archivo desde Supabase
    const { data, error } = await supabase.storage
      .from("expedientes")
      .download(archivo_path);

    if (error) throw error;

    const arrayBuffer = await data.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Extraer texto
    let textoExtraido = "";
    if (archivo_path.toLowerCase().endsWith(".pdf")) {
      textoExtraido = await extraerTextoPDF(buffer);
    } else if (archivo_path.toLowerCase().endsWith(".docx")) {
      const { value } = await mammoth.extractRawText({ buffer });
      textoExtraido = value;
    }

    // Llamar a la IA (DeepSeek)
    const prompt = `
      Eres un abogado experto en cobro coactivo colombiano.
      Analiza el siguiente texto y devuelve únicamente un objeto JSON.

      Debes extraer:
      - nombre del deudor
      - entidad
      - valor total
      - fechas (resolución y ejecutoria)
      - tipo de título
      Y clasificar:
      - VERDE = válido y ejecutoriado
      - AMARILLO = inconsistencias menores
      - ROJO = no válido

      Formato exacto:

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
      ${textoExtraido}
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

    const dataIA = await iaResponse.json();
    const content = dataIA?.choices?.[0]?.message?.content || "{}";
    const json = JSON.parse(content.replace(/```json|```/g, "").trim());

    // Actualizar registro en Supabase
    await supabase
      .from("expedientes")
      .update({
        titulo: json.tipo_titulo,
        semaforo: json.semaforo,
        observaciones: json.observacion,
      })
      .eq("id", expediente_id);

    res.json({ ok: true, resultado: json });
  } catch (err) {
    console.error("Error en worker:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Función para extraer texto de un PDF usando pdf2json
async function extraerTextoPDF(buffer) {
  return new Promise((resolve, reject) => {
    const pdfParser = new PDFParser();

    pdfParser.on("pdfParser_dataError", (errData) =>
      reject(errData.parserError)
    );
    pdfParser.on("pdfParser_dataReady", (pdfData) => {
      const texto = pdfData.Pages.map((page) =>
        page.Texts.map((t) => decodeURIComponent(t.R[0].T)).join(" ")
      ).join("\n");
      resolve(texto);
    });

    pdfParser.parseBuffer(buffer);
  });
}

app.listen(process.env.PORT || 3000, () =>
  console.log(`Worker corriendo en puerto ${process.env.PORT || 3000}`)
);
