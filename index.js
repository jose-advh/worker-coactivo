import express from "express";
import mammoth from "mammoth";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import "pdfjs-dist/build/pdf.worker.mjs";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

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
      const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
      let texto = "";
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        texto += content.items.map((t) => t.str).join(" ");
      }
      textoExtraido = texto;
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

app.listen(process.env.PORT || 3000, () =>
  console.log(`Worker corriendo en puerto ${process.env.PORT || 3000}`)
);
