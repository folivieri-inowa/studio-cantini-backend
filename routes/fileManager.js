import * as Minio from 'minio';
import { sanitizeFileName } from '../lib/utils.js';

const fileManager = async (fastify) => {
  // Funzione per decodificare in modo sicuro i percorsi
  const safeDecodeURIComponent = (str) => {
    try {
      return str ? decodeURIComponent(str) : null;
    } catch (e) {
      console.error('Errore nella decodifica del percorso:', e);
      return str; // Ritorna la stringa originale in caso di errore
    }
  };

  // Configurazione client MinIO
  const getMinioClient = () => new Minio.Client({
    endPoint: 'minio.studiocantini.inowa.it',
    port: 443,
    useSSL: true,
    accessKey: 'minioAdmin',
    secretKey: 'Inowa2024',
  });

  // Funzione per verificare/creare bucket
  const ensureBucketExists = async (minioClient, bucketName) => {
    const bucketExists = await minioClient.bucketExists(bucketName);
    if (!bucketExists) {
      await minioClient.makeBucket(bucketName, 'us-east-1');
    }
  };

  // Funzione per ottenere i file da Minio
  const getDataFromMinio = (bucketName) => {
    return new Promise((resolve, reject) => {
      console.log(`Recupero file dal bucket: ${bucketName}`);
      const minioClient = getMinioClient();
      const data = [];
      const stream = minioClient.listObjectsV2(bucketName, '', true);

      stream.on('data', (obj) => {
        console.log(`File trovato in Minio: ${obj.name}, size: ${obj.size}`);
        data.push(obj);
      });

      stream.on('end', () => {
        console.log(`Totale file trovati in Minio: ${data.length}`);
        if (data.length === 0) {
          console.log(`ATTENZIONE: Nessun file trovato nel bucket ${bucketName}!`);
        }
        resolve(data);
      });

      stream.on('error', (err) => {
        console.error(`Errore durante il recupero dei file dal bucket ${bucketName}:`, err);
        reject(err);
      });
    });
  };

  // Endpoint per ottenere la struttura delle cartelle e file
  fastify.get('/:db', async (request, reply) => {
    const { db } = request.params;
    const minioClient = getMinioClient();

    try {
      // Recupera le categorie, i soggetti e i dettagli dal database
      const hierarchyQuery = `
        SELECT 
          c.id AS categoryId, c.name AS categoryName, 
          s.id AS subjectId, s.name AS subjectName,
          d.id AS detailId, d.name AS detailName
        FROM categories c
        LEFT JOIN subjects s ON c.id = s.category_id
        LEFT JOIN details d ON s.id = d.subject_id
        WHERE c.db = $1
        ORDER BY c.name, s.name, d.name;
      `;
      const { rows: hierarchyRows } = await fastify.pg.query(hierarchyQuery, [db]);

      // Struttura gerarchica per cartelle
      const folderStructure = hierarchyRows.reduce((acc, item) => {
        if (!item.categoryname) {
          return acc;
        }

        // Trova o crea la categoria
        let categoryFolder = acc.find((folder) => folder.name === item.categoryname);
        if (!categoryFolder) {
          categoryFolder = {
            id: item.categoryid,
            name: item.categoryname,
            type: 'folder',
            subfolderCount: 0,
            fileCount: 0,
            subfolder: [],
          };
          acc.push(categoryFolder);
        }

        // Aggiungi il soggetto come sottocartella se esiste
        if (item.subjectid && item.subjectname) {
          // Verifica se il soggetto esiste già come sottocartella
          let subjectFolder = categoryFolder.subfolder.find(
            (sub) => sub.name === item.subjectname
          );
          
          if (!subjectFolder) {
            subjectFolder = {
              id: item.subjectid,
              name: item.subjectname,
              type: 'folder',
              parentId: item.categoryid,
              fileCount: 0,
              subfolderCount: 0,
              subfolder: [],
            };
            categoryFolder.subfolder.push(subjectFolder);
            categoryFolder.subfolderCount++;
          }

          // Aggiungi il dettaglio come sotto-sottocartella se esiste
          if (item.detailid && item.detailname) {
            const detailExists = subjectFolder.subfolder.some(
              (detail) => detail.name === item.detailname
            );
            
            if (!detailExists) {
              subjectFolder.subfolder.push({
                id: item.detailid,
                name: item.detailname,
                type: 'folder',
                parentId: item.subjectid,
                fileCount: 0,
                files: [],
              });
              subjectFolder.subfolderCount++;
            }
          }
        }

        return acc;
      }, []);

      try {
        // Assicurati che il bucket esista
        await ensureBucketExists(minioClient, db);
        
        // Recupera i file da Minio
        const files = await getDataFromMinio(db);

        // Aggiunge i documenti alle cartelle appropriate
        files.forEach((file) => {
          // Esempio formato percorso: "Categoria/Soggetto/Dettaglio/file.pdf"
          const filePath = file.name.split('/');
          const fileName = filePath.pop(); // Ottieni il nome del file
          
          // Normalizza i nomi delle cartelle per gestire caratteri speciali e spazi
          const categoryName = safeDecodeURIComponent(filePath[0]);
          const subjectName = filePath.length > 1 ? safeDecodeURIComponent(filePath[1]) : null;
          const detailName = filePath.length > 2 ? safeDecodeURIComponent(filePath[2]) : null;
          
          console.log(`File trovato: ${file.name}, categoria: ${categoryName}, soggetto: ${subjectName}, dettaglio: ${detailName}, nome file: ${fileName}`);
          console.log(`Percorso originale: ${file.name}, parti del percorso: ${filePath.join(', ')}`);
          
          // Verifica se i nomi sono diversi da quelli nel DB a causa di spazi o caratteri speciali
          const originalCategoryName = filePath[0];
          const originalSubjectName = filePath.length > 1 ? filePath[1] : null;
          const originalDetailName = filePath.length > 2 ? filePath[2] : null;

          // Trova la categoria con controllo più flessibile
          let categoryFolder = folderStructure.find(
            (folder) => folder.name === categoryName
          );
          
          // Log per debug su tutte le categorie disponibili
          console.log(`Categorie disponibili: ${folderStructure.map(f => f.name).join(', ')}`);
          
          // Se non trova la categoria, prova con confronto case-insensitive o confrontando solo l'inizio del nome
          if (!categoryFolder) {
            categoryFolder = folderStructure.find(
              (folder) => folder.name.toLowerCase() === categoryName.toLowerCase()
            );
          }
          
          // Se ancora non trova, prova a sostituire gli underscore con spazi o viceversa
          if (!categoryFolder && categoryName.includes('_')) {
            const nameWithSpaces = categoryName.replace(/_/g, ' ');
            categoryFolder = folderStructure.find(
              (folder) => folder.name === nameWithSpaces
            );
          } else if (!categoryFolder && categoryName.includes(' ')) {
            const nameWithUnderscores = categoryName.replace(/ /g, '_');
            categoryFolder = folderStructure.find(
              (folder) => folder.name === nameWithUnderscores
            );
          }
          
          if (categoryFolder) {
            // Se esiste solo la categoria
            if (!subjectName) {
              if (!categoryFolder.files) {
                categoryFolder.files = [];
              }
              
              categoryFolder.files.push({
                id: file.etag,
                name: fileName,
                size: file.size,
                type: fileName.split('.').pop(),
                url: `https://minio.studiocantini.inowa.it/${db}/${file.name}`,
                modifiedDate: file.lastModified,
              });
              
              categoryFolder.fileCount++;
              return;
            }

            // Trova il soggetto con controllo più flessibile
            let subjectFolder = categoryFolder.subfolder.find(
              (sub) => sub.name === subjectName
            );
            
            // Log per debug su tutti i soggetti disponibili nella categoria
            console.log(`Soggetti disponibili in ${categoryFolder.name}: ${categoryFolder.subfolder.map(s => s.name).join(', ')}`);
            
            // Se non trova il soggetto, prova con confronto case-insensitive
            if (!subjectFolder) {
              subjectFolder = categoryFolder.subfolder.find(
                (sub) => sub.name.toLowerCase() === subjectName.toLowerCase()
              );
            }
            
            // Prova a sostituire underscore con spazi o viceversa
            if (!subjectFolder && subjectName && subjectName.includes('_')) {
              const nameWithSpaces = subjectName.replace(/_/g, ' ');
              subjectFolder = categoryFolder.subfolder.find(
                (sub) => sub.name === nameWithSpaces
              );
            } else if (!subjectFolder && subjectName && subjectName.includes(' ')) {
              const nameWithUnderscores = subjectName.replace(/ /g, '_');
              subjectFolder = categoryFolder.subfolder.find(
                (sub) => sub.name === nameWithUnderscores
              );
            }

            if (subjectFolder) {
              // Se esiste solo soggetto (senza dettagli)
              if (!detailName) {
                if (!subjectFolder.files) {
                  subjectFolder.files = [];
                }
                
                subjectFolder.files.push({
                  id: file.etag,
                  name: fileName,
                  size: file.size,
                  type: fileName.split('.').pop(),
                  url: `https://minio.studiocantini.inowa.it/${db}/${file.name}`,
                  modifiedDate: file.lastModified,
                });
                
                subjectFolder.fileCount++;
                return;
              }

              // Trova il dettaglio con controllo più flessibile
              let detailFolder = subjectFolder.subfolder.find(
                (detail) => detail.name === detailName
              );
              
              // Log per debug su tutti i dettagli disponibili nel soggetto
              if (subjectFolder.subfolder && subjectFolder.subfolder.length > 0) {
                console.log(`Dettagli disponibili in ${subjectFolder.name}: ${subjectFolder.subfolder.map(d => d.name).join(', ')}`);
              }
              
              // Se non trova il dettaglio, prova con confronto case-insensitive
              if (!detailFolder) {
                detailFolder = subjectFolder.subfolder.find(
                  (detail) => detail.name.toLowerCase() === detailName.toLowerCase()
                );
              }
              
              // Prova a sostituire underscore con spazi o viceversa
              if (!detailFolder && detailName && detailName.includes('_')) {
                const nameWithSpaces = detailName.replace(/_/g, ' ');
                detailFolder = subjectFolder.subfolder.find(
                  (detail) => detail.name === nameWithSpaces
                );
              } else if (!detailFolder && detailName && detailName.includes(' ')) {
                const nameWithUnderscores = detailName.replace(/ /g, '_');
                detailFolder = subjectFolder.subfolder.find(
                  (detail) => detail.name === nameWithUnderscores
                );
              }

              if (detailFolder) {
                if (!detailFolder.files) {
                  detailFolder.files = [];
                }
                
                detailFolder.files.push({
                  id: file.etag,
                  name: fileName,
                  size: file.size,
                  type: fileName.split('.').pop(),
                  url: `https://minio.studiocantini.inowa.it/${db}/${file.name}`,
                  modifiedDate: file.lastModified,
                });
                
                detailFolder.fileCount++;
              } else {
                console.log(`ATTENZIONE: Dettaglio non trovato per il file ${file.name}! Nome dettaglio: "${detailName}" in soggetto "${subjectFolder.name}"`);
                // Confronto dettagliato
                if (subjectFolder.subfolder && subjectFolder.subfolder.length > 0) {
                  console.log('Confronto tra nomi dettaglio:');
                  subjectFolder.subfolder.forEach(detail => {
                    console.log(`DB: "${detail.name}" vs File: "${detailName}" - Match: ${detail.name === detailName}`);
                  });
                } else {
                  console.log('Il soggetto non ha sottofolders definiti');
                }
                return; // Salta questo file
              }
            }
          } else {
            console.log(`ATTENZIONE: Categoria non trovata per il file ${file.name}! Nome categoria: "${categoryName}"`);
            // Poiché la categoria non è stata trovata, creiamo una struttura temporanea per debug
            console.log('Confronto tra nomi categoria:');
            folderStructure.forEach(folder => {
              console.log(`DB: "${folder.name}" vs File: "${categoryName}" - Match: ${folder.name === categoryName}`);
              // Confronto byte per byte per trovare differenze invisibili
              const dbBytes = [...folder.name].map(c => c.charCodeAt(0));
              const fileBytes = [...categoryName].map(c => c.charCodeAt(0));
              console.log(`DB bytes: ${dbBytes.join(',')}`);
              console.log(`File bytes: ${fileBytes.join(',')}`);
            });
            return; // Salta questo file
          }
        });
      } catch (minioError) {
        console.error('Errore durante il recupero dei file da MinIO:', minioError);
        // Continua con la struttura delle cartelle anche se non ci sono file
      }

      reply.send(folderStructure).code(200);
    } catch (err) {
      console.error('Errore durante il recupero dei dati:', err);
      reply.status(500).send({ error: 'Failed to fetch data', details: err.message });
    }
  });

  // Endpoint per caricare un nuovo file
  fastify.post('/upload/:db', async (request, reply) => {
    const { db } = request.params;
    const { categoryId, subjectId, detailId } = request.query;
    
    try {
      // Ottieni informazioni sulla categoria/soggetto/dettaglio
      const hierarchyQuery = `
        SELECT 
          c.name AS categoryName,
          s.name AS subjectName,
          d.name AS detailName
        FROM categories c
        LEFT JOIN subjects s ON c.id = s.category_id AND s.id = $2
        LEFT JOIN details d ON s.id = d.subject_id AND d.id = $3
        WHERE c.id = $1;
      `;
      
      const { rows } = await fastify.pg.query(hierarchyQuery, [categoryId, subjectId || null, detailId || null]);
      
      if (!rows.length || !rows[0].categoryname) {
        return reply.code(404).send({ message: 'Categoria non trovata' });
      }
      
      const { categoryname, subjectname, detailname } = rows[0];
      
      // Elabora il file caricato
      const data = await request.file();
      const { filename, mimetype, file } = data;
      
      const sanitizedFilename = sanitizeFileName(filename);
      
      // Costruisci il path del file
      let objectPath = categoryname;
      if (subjectname) {
        objectPath += `/${subjectname}`;
        if (detailname) {
          objectPath += `/${detailname}`;
        }
      }
      objectPath += `/${sanitizedFilename}`;
      
      // Replace spaces with underscores in the path
      objectPath = objectPath.replace(/\s+/g, '_');
      
      const minioClient = getMinioClient();
      
      // Assicurati che il bucket esista
      await ensureBucketExists(minioClient, db);
      
      // Carica il file su MinIO
      await minioClient.putObject(db, objectPath, file, {
        'Content-Type': mimetype
      });
      
      // Costruisci l'URL del file
      const fileUrl = `https://minio.studiocantini.inowa.it/${db}/${objectPath}`;
      
      reply.send({ 
        message: 'File caricato con successo.',
        url: fileUrl,
        file: {
          name: sanitizedFilename,
          url: fileUrl,
          size: 0, // Non abbiamo la dimensione del file in questo punto
          type: sanitizedFilename.split('.').pop(),
          path: objectPath,
        }
      });
    } catch (err) {
      console.error('Errore durante il caricamento del file:', err);
      reply.code(500).send({ message: 'Errore durante il caricamento del file', details: err.message });
    }
  });

  // Endpoint per eliminare un file
  fastify.delete('/:db', async (request, reply) => {
    const { db } = request.params;
    const { filePath } = request.query;
    
    if (!filePath) {
      return reply.code(400).send({ message: 'Percorso del file mancante' });
    }
    
    try {
      const minioClient = getMinioClient();
      
      // Elimina il file da MinIO
      await minioClient.removeObject(db, filePath);
      
      // Se il file è associato a una transazione, rimuovi anche quel collegamento
      const fileUrl = `https://minio.studiocantini.inowa.it/${db}/${filePath}`;
      
      const deleteDocumentQuery = `
        DELETE FROM documents
        WHERE url = $1 AND db = $2;
      `;
      
      await fastify.pg.query(deleteDocumentQuery, [fileUrl, db]);
      
      reply.send({ message: 'File eliminato con successo' });
    } catch (err) {
      console.error('Errore durante l\'eliminazione del file:', err);
      reply.code(500).send({ message: 'Errore durante l\'eliminazione del file', details: err.message });
    }
  });
  
  // Endpoint per ottenere informazioni sulle transazioni associate a un file
  fastify.get('/file-info/:db', async (request, reply) => {
    const { db } = request.params;
    const { fileUrl } = request.query;
    
    if (!fileUrl) {
      return reply.code(400).send({ message: 'URL del file mancante' });
    }
    
    try {
      const query = `
        SELECT 
          t.id AS transaction_id,
          t.description,
          to_char(t.date, 'YYYY-MM-DD') AS date,
          t.amount
        FROM documents d
        JOIN transactions t ON d.transaction_id = t.id
        WHERE d.url = $1 AND d.db = $2;
      `;
      
      const { rows } = await fastify.pg.query(query, [fileUrl, db]);
      
      reply.send({ 
        isLinked: rows.length > 0,
        transactions: rows
      });
    } catch (err) {
      console.error('Errore durante il recupero delle informazioni sul file:', err);
      reply.code(500).send({ message: 'Errore durante il recupero delle informazioni', details: err.message });
    }
  });

  // Endpoint per associare un file a una transazione
  fastify.post('/link-transaction', async (request, reply) => {
    const { fileUrl, transactionId, db } = request.body;
    
    if (!fileUrl || !transactionId || !db) {
      return reply.code(400).send({
        message: 'fileUrl, transactionId e db sono richiesti'
      });
    }
    
    try {
      // Verifica se esiste già un'associazione
      const checkQuery = `
        SELECT id FROM documents
        WHERE url = $1 AND db = $2;
      `;
      
      const { rows: existingRows } = await fastify.pg.query(checkQuery, [fileUrl, db]);
      
      if (existingRows.length > 0) {
        // Aggiorna l'associazione esistente
        const updateQuery = `
          UPDATE documents
          SET transaction_id = $1
          WHERE url = $2 AND db = $3;
        `;
        
        await fastify.pg.query(updateQuery, [transactionId, fileUrl, db]);
      } else {
        // Crea una nuova associazione
        const insertQuery = `
          INSERT INTO documents (url, transaction_id, db)
          VALUES ($1, $2, $3);
        `;
        
        await fastify.pg.query(insertQuery, [fileUrl, transactionId, db]);
      }
      
      reply.send({ success: true, message: 'File associato alla transazione con successo' });
    } catch (err) {
      console.error('Errore durante l\'associazione del file alla transazione:', err);
      reply.code(500).send({
        message: 'Errore durante l\'associazione del file alla transazione',
        details: err.message
      });
    }
  });
};

export default fileManager;