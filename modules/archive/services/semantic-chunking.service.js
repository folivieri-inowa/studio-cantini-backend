/**
 * Semantic-Aware Chunking Service
 * 
 * Strategia di chunking intelligente che rispetta la semantica del documento:
 * - Rispetta paragrafi e sezioni
 * - Non spezza tabelle
 * - Mantiene coerenza fatture (header + righe)
 * - Gestisce separazione pagine
 * 
 * @module archive/services/semantic-chunking
 */

/**
 * Regex patterns per identificare strutture
 */
const PATTERNS = {
  // Identificatori tabella
  TABLE_START: /(?:^\s*\|)|(?:^\s*[+\-]{3,})|(?:^\s*(?:\w+\s*){2,}\|\s*(?:\w+\s*){2,})/m,
  TABLE_ROW: /^\s*(?:\|[^\n]+\|)|(?:[+\-]{3,})/m,
  
  // Separatori pagina da OCR
  PAGE_BREAK: /\n\s*---\s*PAGE BREAK\s*---\s*\n/i,
  
  // Intestazioni (Markdown-like o caps)
  HEADING: /^#{1,6}\s+.+$|^[A-ZÀ-Ù\s]{10,}$/m,
  
  // Pattern fattura/contratto
  INVOICE_HEADER: /(?:FATTURA|INVOICE|CONTRATTO|CONTRACT)\s*(?:N[°.]?|NUM[.]?)?\s*[\d\/\-]+/i,
  INVOICE_TOTAL: /(?:TOTALE|TOTAL|IMPORTO)\s*[:€$]?\s*[\d,.]+/i,
  
  // Fine paragrafo (doppio newline o punto + newline + maiuscola)
  PARAGRAPH_END: /\.\s*\n\s*(?=[A-ZÀ-Ù])/,
};

/**
 * Semantic Chunking Service
 */
export class SemanticChunkingService {
  constructor({ config = {} }) {
    this.config = {
      minChunkSize: config.minChunkSize || 300,      // Token minimi per chunk
      maxChunkSize: config.maxChunkSize || 800,      // Token massimi per chunk
      targetChunkSize: config.targetChunkSize || 500, // Target ideale
      overlapSize: config.overlapSize || 50,         // Overlap tra chunk consecutivi
      preserveTables: config.preserveTables !== undefined ? config.preserveTables : true,
      preserveInvoices: config.preserveInvoices !== undefined ? config.preserveInvoices : true,
    };
  }

  /**
   * Chunk principale
   * 
   * @param {string} text - Testo pulito da chunkare
   * @param {Object} metadata - Metadata documento (doc_type, etc.)
   * @returns {Array} Array di chunk con metadata
   */
  chunk(text, metadata = {}) {
    // 1. Rilevamento tipo documento
    const docType = this.detectDocumentType(text, metadata);

    // 2. Scegli strategia chunking
    let chunks;
    if (docType === 'invoice' && this.config.preserveInvoices) {
      chunks = this.chunkInvoice(text);
    } else if (docType === 'table_heavy' && this.config.preserveTables) {
      chunks = this.chunkTableHeavy(text);
    } else {
      chunks = this.chunkSemantic(text);
    }

    // 3. Post-processing: aggiungi overlap e metadata
    return this.postProcessChunks(chunks, text, metadata);
  }

  /**
   * Rilevamento tipo documento
   */
  detectDocumentType(text, metadata) {
    if (metadata.doc_type === 'fattura' || PATTERNS.INVOICE_HEADER.test(text.substring(0, 1000))) {
      return 'invoice';
    }

    // Conta righe tabella nei primi 2000 caratteri
    const sample = text.substring(0, 2000);
    const tableLines = (sample.match(PATTERNS.TABLE_ROW) || []).length;
    const totalLines = (sample.match(/\n/g) || []).length;

    if (tableLines / totalLines > 0.3) {
      return 'table_heavy';
    }

    return 'generic';
  }

  /**
   * Chunking generico semantic-aware
   * Rispetta paragrafi e sezioni
   */
  chunkSemantic(text) {
    const chunks = [];
    
    // 1. Split per pagina (se presenti separatori)
    const pages = text.split(PATTERNS.PAGE_BREAK);

    pages.forEach((page, pageIndex) => {
      // 2. Split per sezioni (heading)
      const sections = this.splitByHeadings(page);

      sections.forEach(section => {
        // 3. Split per paragrafi
        const paragraphs = section.split(PATTERNS.PARAGRAPH_END)
          .filter(p => p.trim().length > 0);

        let currentChunk = '';
        let currentTokens = 0;

        paragraphs.forEach(para => {
          const paraTokens = this.estimateTokens(para);

          // Se paragrafo singolo > maxChunkSize, spezzalo per frase
          if (paraTokens > this.config.maxChunkSize) {
            if (currentChunk.trim().length > 0) {
              chunks.push({
                text: currentChunk.trim(),
                tokens: currentTokens,
                page: pageIndex + 1,
              });
              currentChunk = '';
              currentTokens = 0;
            }

            // Spezza paragrafo lungo
            const subChunks = this.splitBySentences(para);
            subChunks.forEach(sub => {
              chunks.push({
                text: sub.trim(),
                tokens: this.estimateTokens(sub),
                page: pageIndex + 1,
              });
            });

          } else if (currentTokens + paraTokens > this.config.maxChunkSize) {
            // Chunk corrente pieno, salvalo
            if (currentChunk.trim().length > 0) {
              chunks.push({
                text: currentChunk.trim(),
                tokens: currentTokens,
                page: pageIndex + 1,
              });
            }
            currentChunk = para;
            currentTokens = paraTokens;

          } else {
            // Aggiungi paragrafo a chunk corrente
            currentChunk += (currentChunk ? '\n\n' : '') + para;
            currentTokens += paraTokens;
          }
        });

        // Salva ultimo chunk
        if (currentChunk.trim().length > 0 && currentTokens >= this.config.minChunkSize) {
          chunks.push({
            text: currentChunk.trim(),
            tokens: currentTokens,
            page: pageIndex + 1,
          });
        }
      });
    });

    return chunks;
  }

  /**
   * Chunking per documenti con tabelle
   * Mantiene tabelle intere quando possibile
   */
  chunkTableHeavy(text) {
    const chunks = [];
    const sections = this.extractTables(text);

    sections.forEach((section, idx) => {
      if (section.type === 'table') {
        // Tabella: mantienila intera se possibile
        const tokens = this.estimateTokens(section.text);
        
        if (tokens <= this.config.maxChunkSize) {
          chunks.push({
            text: section.text.trim(),
            tokens,
            type: 'table',
            page: section.page,
          });
        } else {
          // Tabella troppo grande: spezza per righe
          const rows = section.text.split('\n').filter(r => r.trim());
          let currentChunk = '';
          let currentTokens = 0;

          rows.forEach(row => {
            const rowTokens = this.estimateTokens(row);
            if (currentTokens + rowTokens > this.config.maxChunkSize && currentChunk) {
              chunks.push({
                text: currentChunk.trim(),
                tokens: currentTokens,
                type: 'table_partial',
                page: section.page,
              });
              currentChunk = row;
              currentTokens = rowTokens;
            } else {
              currentChunk += '\n' + row;
              currentTokens += rowTokens;
            }
          });

          if (currentChunk.trim()) {
            chunks.push({
              text: currentChunk.trim(),
              tokens: currentTokens,
              type: 'table_partial',
              page: section.page,
            });
          }
        }
      } else {
        // Testo normale: usa chunking semantico
        const textChunks = this.chunkSemantic(section.text);
        textChunks.forEach(chunk => {
          chunk.page = section.page;
          chunks.push(chunk);
        });
      }
    });

    return chunks;
  }

  /**
   * Chunking per fatture
   * Mantiene insieme header + righe correlate
   */
  chunkInvoice(text) {
    const chunks = [];

    // 1. Estrai header fattura (di solito prime 15-20 righe)
    const lines = text.split('\n');
    const headerEndIndex = Math.min(20, lines.length);
    const headerText = lines.slice(0, headerEndIndex).join('\n');
    
    chunks.push({
      text: headerText.trim(),
      tokens: this.estimateTokens(headerText),
      type: 'invoice_header',
      page: 1,
    });

    // 2. Resto documento: chunking normale o tabella
    const bodyText = lines.slice(headerEndIndex).join('\n');
    const bodyChunks = this.chunkTableHeavy(bodyText);

    bodyChunks.forEach(chunk => {
      chunk.type = chunk.type || 'invoice_body';
      chunks.push(chunk);
    });

    return chunks;
  }

  /**
   * Split testo per heading
   */
  splitByHeadings(text) {
    const sections = [];
    const lines = text.split('\n');
    let currentSection = '';

    lines.forEach(line => {
      if (PATTERNS.HEADING.test(line)) {
        if (currentSection.trim()) {
          sections.push(currentSection.trim());
        }
        currentSection = line + '\n';
      } else {
        currentSection += line + '\n';
      }
    });

    if (currentSection.trim()) {
      sections.push(currentSection.trim());
    }

    return sections.length > 0 ? sections : [text];
  }

  /**
   * Split testo per frasi (fallback per paragrafi lunghi)
   */
  splitBySentences(text) {
    // Split su . ! ? seguito da spazio e maiuscola
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
    
    const chunks = [];
    let currentChunk = '';
    let currentTokens = 0;

    sentences.forEach(sentence => {
      const sentTokens = this.estimateTokens(sentence);

      if (currentTokens + sentTokens > this.config.maxChunkSize && currentChunk) {
        chunks.push(currentChunk.trim());
        currentChunk = sentence;
        currentTokens = sentTokens;
      } else {
        currentChunk += ' ' + sentence;
        currentTokens += sentTokens;
      }
    });

    if (currentChunk.trim()) {
      chunks.push(currentChunk.trim());
    }

    return chunks;
  }

  /**
   * Estrai tabelle dal testo
   * Ritorna array di {type: 'table' | 'text', text, page}
   */
  extractTables(text) {
    const sections = [];
    const lines = text.split('\n');
    
    let currentSection = { type: 'text', text: '', page: 1 };
    let inTable = false;

    lines.forEach(line => {
      const isTableLine = PATTERNS.TABLE_ROW.test(line);

      if (isTableLine && !inTable) {
        // Inizio tabella
        if (currentSection.text.trim()) {
          sections.push(currentSection);
        }
        currentSection = { type: 'table', text: line + '\n', page: currentSection.page };
        inTable = true;
      } else if (!isTableLine && inTable) {
        // Fine tabella
        sections.push(currentSection);
        currentSection = { type: 'text', text: line + '\n', page: currentSection.page };
        inTable = false;
      } else {
        // Continua sezione corrente
        currentSection.text += line + '\n';
      }
    });

    if (currentSection.text.trim()) {
      sections.push(currentSection);
    }

    return sections;
  }

  /**
   * Post-processing chunks:
   * - Aggiungi overlap
   * - Aggiungi metadata finali
   * - Filtra chunk troppo piccoli
   */
  postProcessChunks(chunks, fullText, metadata) {
    const processed = [];

    chunks.forEach((chunk, index) => {
      // Filtra chunk troppo piccoli (< minChunkSize) eccetto se sono tabelle o header
      if (chunk.tokens < this.config.minChunkSize && 
          !['table', 'invoice_header'].includes(chunk.type)) {
        // Merge con chunk precedente se possibile
        if (processed.length > 0) {
          const prev = processed[processed.length - 1];
          prev.chunk_text += '\n\n' + chunk.text;
          prev.token_count += chunk.tokens;
          prev.char_offset_end = this.findOffset(fullText, chunk.text) + chunk.text.length;
        }
        return;
      }

      // Calcola offset caratteri
      const startOffset = this.findOffset(fullText, chunk.text);
      const endOffset = startOffset + chunk.text.length;

      // Aggiungi overlap con chunk precedente
      let overlap = '';
      if (this.config.overlapSize > 0 && index > 0 && chunks[index - 1]) {
        const prevText = chunks[index - 1].text;
        const overlapChars = Math.min(this.config.overlapSize * 4, prevText.length); // ~4 char/token
        overlap = prevText.substring(prevText.length - overlapChars);
      }

      processed.push({
        chunk_index: processed.length,
        chunk_text: (overlap ? `[...${overlap}]\n\n` : '') + chunk.text,
        token_count: chunk.tokens + (overlap ? this.estimateTokens(overlap) : 0),
        page_start: chunk.page || 1,
        page_end: chunk.page || 1,
        char_offset_start: startOffset,
        char_offset_end: endOffset,
        chunk_type: chunk.type || 'text',
      });
    });

    return processed;
  }

  /**
   * Stima token count
   * Approx: 1 token ≈ 4 caratteri per italiano
   */
  estimateTokens(text) {
    return Math.ceil(text.length / 4);
  }

  /**
   * Trova offset carattere nel testo completo
   */
  findOffset(fullText, chunkText) {
    const index = fullText.indexOf(chunkText.substring(0, 100)); // Usa primi 100 char per match
    return index >= 0 ? index : 0;
  }
}

export default SemanticChunkingService;
