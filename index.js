import express from "express";
import mammoth from "mammoth";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";
import PDFParser from "pdf2json";

const app = express();
app.use(express.json());

// 🔗 Conexión con Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

// 🧾 Endpoint principal
app.post("/procesar", async (req, res) => {
  try {
    const { expediente_id, archivo_path } = req.body;
    console.log(`📂 Procesando expediente: ${expediente_id}`);
    console.log(`📄 Archivo: ${archivo_path}`);

    // 🧱 Descargar archivo desde Supabase
    let data, error;
    try {
      ({ data, error } = await supabase.storage
        .from("expedientes")
        .download(archivo_path));
      if (error) throw error;
      console.log("✅ Archivo descargado correctamente desde Supabase");
    } catch (err) {
      console.error(
        "❌ Error al descargar archivo desde Supabase:",
        err.message
      );
      throw err;
    }

    // 🧩 Convertir a Buffer
    let buffer;
    try {
      const arrayBuffer = await data.arrayBuffer();
      buffer = Buffer.from(arrayBuffer);
      console.log(`✅ Archivo convertido a Buffer (${buffer.length} bytes)`);
    } catch (err) {
      console.error("❌ Error al convertir archivo a Buffer:", err.message);
      throw err;
    }

    // 🧠 Extraer texto
    let textoExtraido = "";
    try {
      if (archivo_path.toLowerCase().endsWith(".pdf")) {
        console.log("📘 Extrayendo texto de PDF...");
        textoExtraido = await extraerTextoPDF(buffer);
      } else if (archivo_path.toLowerCase().endsWith(".docx")) {
        console.log("📗 Extrayendo texto de DOCX...");
        const { value } = await mammoth.extractRawText({ buffer });
        textoExtraido = value;
      } else {
        throw new Error("Formato de archivo no soportado");
      }

      console.log(
        `✅ Texto extraído correctamente (${textoExtraido.length} caracteres)`
      );
      console.log("🔍 Vista previa del texto:", textoExtraido.slice(0, 300));
    } catch (err) {
      console.error("❌ Error al extraer texto del archivo:", err.message);
      throw err;
    }

    // 🧑‍⚖️ Construir prompt
    const prompt = `
      Eres un abogado experto en cobro coactivo colombiano.
      Analiza el siguiente texto y devuelve únicamente un objeto JSON. Nada de texto introductorio, solo el JSON.

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

    // 🤖 Llamar a la IA
    try {
      console.log("🛰️ Enviando texto a DeepSeek...");
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
                content:
                  "Eres un abogado experto en cobro coactivo colombiano.",
              },
              { role: "user", content: prompt },
            ],
          }),
        }
      );

      const data = await iaResponse.json();
      if (data?.error)
        throw new Error(data.error.message || "Error en OpenRouter");

      const textoIA = data?.choices?.[0]?.message?.content.trim() || "{}";
      let limpio = textoIA
        .replace(/```json|```/g, "")
        .replace(/[^\{]*({[\s\S]*})[^\}]*$/, "$1")
        .trim();

      try {
        json = JSON.parse(limpio);
        console.log("✅ JSON parseado correctamente:", json);
      } catch (e) {
        console.error("❌ Error al parsear JSON de IA:", e.message);
        json = {
          tipo_titulo: "",
          semaforo: "ROJO",
          observacion: "Error al interpretar la respuesta de la IA",
        };
      }

      // 🗃️ Actualizar registro en Supabase
      try {
        const { error: updateError } = await supabase
          .from("expedientes")
          .update({
            titulo: json.tipo_titulo,
            semaforo: json.semaforo,
            observaciones: json.observacion,
          })
          .eq("id", expediente_id);

        if (updateError) throw updateError;
        console.log(`✅ Expediente ${expediente_id} actualizado en Supabase`);
      } catch (err) {
        console.error("❌ Error al actualizar Supabase:", err.message);
        throw err;
      }
      console.log("✅ Respuesta recibida de la IA:");
      console.log(textoIA.slice(0, 500)); // limitar a 500 chars
      res.json({ ok: true, resultado: json });
    } catch (err) {
      console.error("❌ Error al comunicarse con la IA:", err.message);
      throw err;
    }
  } catch (err) {
    console.error("💥 Error general en worker:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 📘 Función para extraer texto de PDF
async function extraerTextoPDF(buffer) {
  return new Promise((resolve, reject) => {
    try {
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
    } catch (err) {
      reject(err);
    }
  });
}

// 🚀 Inicialización
app.listen(process.env.PORT || 3000, () =>
  console.log(`⚙️ Worker corriendo en puerto ${process.env.PORT || 3000}`)
);
