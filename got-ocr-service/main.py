"""
GOT-OCR 2.0 Service
Microservizio FastAPI che espone GOT-OCR2_0 via HTTP.
Interfaccia identica a Docling per semplicità di integrazione.
"""

import io
import os
import logging
from contextlib import asynccontextmanager

import fitz  # PyMuPDF
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.responses import JSONResponse
from PIL import Image
from transformers import AutoTokenizer, AutoModelForCausalLM

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Configurazione
MODEL_NAME = os.getenv("GOT_OCR_MODEL", "ucaslcl/GOT-OCR2_0")
MAX_PAGES = int(os.getenv("GOT_OCR_MAX_PAGES", "50"))
DPI = int(os.getenv("GOT_OCR_DPI", "150"))

# Stato globale del modello (caricato una volta all'avvio)
model_state = {
    "tokenizer": None,
    "model": None,
    "loaded": False,
}


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Carica il modello all'avvio del servizio."""
    logger.info(f"🔄 Caricamento modello {MODEL_NAME}...")
    try:
        tokenizer = AutoTokenizer.from_pretrained(
            MODEL_NAME,
            trust_remote_code=True,
        )
        model = AutoModelForCausalLM.from_pretrained(
            MODEL_NAME,
            trust_remote_code=True,
            low_cpu_mem_usage=True,
            device_map="cpu",
            use_safetensors=True,
            pad_token_id=tokenizer.eos_token_id,
        )
        model = model.eval()

        model_state["tokenizer"] = tokenizer
        model_state["model"] = model
        model_state["loaded"] = True
        logger.info("✅ Modello GOT-OCR2_0 caricato con successo")
    except Exception as e:
        logger.error(f"❌ Errore caricamento modello: {e}")
        # Non blocca l'avvio — /health risponderà model_loaded: false
    yield
    logger.info("🛑 Shutdown servizio GOT-OCR")


app = FastAPI(title="GOT-OCR Service", lifespan=lifespan)


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "model_loaded": model_state["loaded"],
        "model": MODEL_NAME,
    }


def pdf_to_images(pdf_bytes: bytes, dpi: int = 150) -> list:
    """Converte un PDF in lista di immagini PIL, una per pagina."""
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    images = []
    mat = fitz.Matrix(dpi / 72, dpi / 72)

    for page_num in range(min(len(doc), MAX_PAGES)):
        page = doc[page_num]
        pix = page.get_pixmap(matrix=mat)
        img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
        images.append(img)

    doc.close()
    return images


def ocr_image(image: Image.Image) -> str:
    """Applica GOT-OCR 2.0 a una singola immagine PIL."""
    tokenizer = model_state["tokenizer"]
    model = model_state["model"]

    result = model.chat(
        tokenizer,
        image,
        ocr_type="ocr",
    )
    return result.strip() if result else ""


@app.post("/ocr")
async def ocr_endpoint(file: UploadFile = File(...)):
    """
    Endpoint OCR principale.
    Accetta PDF o immagine, ritorna il testo estratto.
    """
    if not model_state["loaded"]:
        raise HTTPException(
            status_code=503,
            detail="Modello non ancora caricato, riprova tra qualche secondo",
        )

    content = await file.read()
    filename = file.filename or "document"

    logger.info(f"📄 OCR richiesta: {filename} ({len(content)} bytes)")

    MAX_FILE_SIZE = int(os.getenv("GOT_OCR_MAX_FILE_MB", "50")) * 1024 * 1024
    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(
            status_code=413,
            detail=f"File troppo grande: {len(content) // (1024*1024)}MB (max {MAX_FILE_SIZE // (1024*1024)}MB)"
        )

    try:
        is_pdf = filename.lower().endswith(".pdf") or file.content_type == "application/pdf"

        if is_pdf:
            images = pdf_to_images(content, dpi=DPI)
            logger.info(f"📄 PDF: {len(images)} pagine")

            if not images:
                raise HTTPException(status_code=422, detail="PDF senza pagine o non processabile")

            page_texts = []
            for i, image in enumerate(images):
                logger.info(f"🔍 OCR pagina {i + 1}/{len(images)}...")
                text = ocr_image(image)
                if text:
                    page_texts.append(text)

            full_text = "\n\n---\n\n".join(page_texts)
            num_pages = len(images)
        else:
            image = Image.open(io.BytesIO(content)).convert("RGB")
            full_text = ocr_image(image)
            num_pages = 1

        logger.info(f"✅ OCR completato: {len(full_text)} caratteri estratti")

        return JSONResponse(content={"text": full_text, "pages": num_pages})

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"❌ Errore OCR interno: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Errore interno durante l'elaborazione OCR")
