import * as Minio from 'minio';

const fileManager = async (fastify) => {
  fastify.get('/:db', async (request, reply) => {
    const { db } = request.params;

    const minioClient = new Minio.Client({
      endPoint: 'minio.studiocantini.inowa.it',
      port: 443,
      useSSL: true,
      accessKey: 'minioAdmin',
      secretKey: 'Inowa2024',
    });

    // Funzione per ottenere i file da Minio
    const getDataFromMinio = (db) => {
      return new Promise((resolve, reject) => {
        const data = [];
        const stream = minioClient.listObjectsV2(db, '', true);

        stream.on('data', (obj) => {
          data.push(obj);
        });

        stream.on('end', () => {
          resolve(data);
        });

        stream.on('error', (err) => {
          reject(err);
        });
      });
    };

    try {
      // Recupera le categorie e i soggetti dal database
      const categoriesQuery = `
        SELECT c.id AS categoryId, c.name AS categoryName, s.id AS subjectId, s.name AS subjectName
        FROM categories c
        LEFT JOIN subjects s ON c.id = s.category_id
        WHERE c.db = $1
        ORDER BY c.name, s.name;
      `;
      const { rows: categoriesRows } = await fastify.pg.query(categoriesQuery, [db]);

      // Struttura iniziale delle cartelle
      const folderStructure = categoriesRows.reduce((acc, category) => {
        if (!category.categoryname) {
          console.warn('Categoria senza nome:', category);
          return acc; // Salta le categorie senza nome
        }

        // Trova o crea la categoria
        let categoryFolder = acc.find((folder) => folder.name === category.categoryname);
        if (!categoryFolder) {
          categoryFolder = {
            name: category.categoryname,
            type: 'folder',
            subfolderCount: 0,
            fileCount: 0,
            subfolder: [],
          };
          acc.push(categoryFolder);
        }

        // Aggiungi il soggetto come sottocartella
        if (category.subjectid) {
          categoryFolder.subfolder.push({
            name: category.subjectname,
            type: 'folder',
            fileCount: 0,
            files: [],
          });
          categoryFolder.subfolderCount++;
        }

        return acc;
      }, []);

      // Recupera i file da Minio
      const files = await getDataFromMinio(db);

      // Popola le cartelle con i file
      files.forEach((file) => {
        const filePath = file.name.split('/'); // Divide il percorso del file
        const categoryName = filePath[0]; // Nome della categoria
        const subjectName = filePath[1]; // Nome del soggetto (sottocartella)

        // Trova la categoria corrispondente
        const categoryFolder = folderStructure.find((folder) => folder.name === categoryName);
        if (categoryFolder) {
          if (subjectName) {
            // Trova la sottocartella corrispondente
            const subjectFolder = categoryFolder.subfolder.find((sub) => sub.name === subjectName);
            if (subjectFolder) {
              subjectFolder.files.push(file); // Aggiungi il file alla sottocartella
              subjectFolder.fileCount++; // Incrementa il conteggio dei file
            }
          } else {
            // Aggiungi il file direttamente alla categoria
            categoryFolder.fileCount++;
          }
        }
      });

      reply.send(folderStructure).code(200);
    } catch (err) {
      console.error('Errore durante il recupero dei dati:', err);
      reply.status(500).send({ error: 'Failed to fetch data' });
    }
  });
};

export default fileManager;