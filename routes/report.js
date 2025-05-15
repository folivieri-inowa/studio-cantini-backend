const report = async (fastify) => {
  fastify.get('/master/:db', async (request, reply) => {
    const db = request.params.db;

    try {
      // Fetch owner data including initial balance - corretto initialBalance in initialbalance
      const { rows: ownersData } = await fastify.pg.query(`
        SELECT 
          id, 
          name, 
          cc, 
          iban, 
          initialbalance as "initialBalance",
          "date" as balanceDate,
          is_credit_card as "isCreditCard"
        FROM 
          owners
        WHERE 
          db = $1
      `, [db]);

      // Create a map for quick lookup
      const ownerMap = {};
      ownersData.forEach(owner => {
        ownerMap[owner.id] = {
          initialBalance: parseFloat(owner.initialBalance || 0),
          balanceDate: owner.balanceDate,
          isCreditCard: owner.isCreditCard || false
        };
      });

      // Fetch all transactions from PostgreSQL
      const { rows: transactions } = await fastify.pg.query(`
      SELECT 
        t.id,
        to_char(t.date, 'YYYY-MM-DD') AS date,
        t.amount,
        t.categoryid,
        c.name AS categoryname,
        t.ownerid,
        o.name AS ownername,
        o.cc,
        o.iban
      FROM 
        transactions t
      JOIN
        categories c ON t.categoryid = c.id
      JOIN
        owners o ON t.ownerid = o.id
      WHERE 
        t.db = $1
    `, [db]);

      let reportByOwner = {};

      // Process each transaction to build the report structure
      transactions.forEach(tx => {
        const date = new Date(tx.date);
        const year = date.getFullYear().toString();
        const month = (date.getMonth() + 1).toString().padStart(2, '0');
        const amount = parseFloat(tx.amount);
        const categoryId = tx.categoryid;
        const categoryName = tx.categoryname || 'Senza Categoria';
        const ownerId = tx.ownerid;

        if (!ownerId) return;

        // Initialize the report for the owner
        if (!reportByOwner[ownerId]) {
          reportByOwner[ownerId] = {
            id: ownerId,
            name: tx.ownername,
            cc: tx.cc || null,
            iban: tx.iban || null,
            initialBalance: ownerMap[ownerId]?.initialBalance || 0,
            balanceDate: ownerMap[ownerId]?.balanceDate || null,
            isCreditCard: ownerMap[ownerId]?.isCreditCard || false,
            report: {
              years: new Set(),
              globalReport: {},
              categoryReport: {},
            },
          };
        }

        const report = reportByOwner[ownerId].report;
        report.years.add(year);

        // Initialize globalReport
        if (!report.globalReport[year]) {
          report.globalReport[year] = { income: 0, expense: 0, months: {} };
        }
        if (!report.globalReport[year].months[month]) {
          report.globalReport[year].months[month] = { income: 0, expense: 0 };
        }

        // Initialize categoryReport
        if (!report.categoryReport[year]) {
          report.categoryReport[year] = {};
        }
        if (!report.categoryReport[year][categoryId]) {
          report.categoryReport[year][categoryId] = {
            id: categoryId,
            name: categoryName,
            totalIncome: 0,
            totalExpense: 0,
            months: {},
          };
        }
        if (!report.categoryReport[year][categoryId].months[month]) {
          report.categoryReport[year][categoryId].months[month] = { income: 0, expense: 0 };
        }

        // Update global and category totals
        if (amount >= 0) {
          // Arrotondiamo a 2 decimali per maggiore precisione
          const amountRounded = parseFloat(amount.toFixed(2));
          report.globalReport[year].income += amountRounded;
          report.globalReport[year].months[month].income += amountRounded;
          report.categoryReport[year][categoryId].totalIncome += amountRounded;
          report.categoryReport[year][categoryId].months[month].income += amountRounded;
        } else {
          // Arrotondiamo a 2 decimali per maggiore precisione
          const absAmount = parseFloat(Math.abs(amount).toFixed(2));
          report.globalReport[year].expense += absAmount;
          report.globalReport[year].months[month].expense += absAmount;
          report.categoryReport[year][categoryId].totalExpense += absAmount;
          report.categoryReport[year][categoryId].months[month].expense += absAmount;
        }
      });

      // Convert Sets to arrays and sort years
      let reports = [];
      Object.values(reportByOwner).forEach(entry => {
        entry.report.years = Array.from(entry.report.years).sort((a, b) => b - a);
        reports.push(entry);
      });

      reply.send(reports);
    } catch (error) {
      console.error('Error generating report', error);
      reply.status(500).send({ error: 'Failed to generate report' });
    }
  });

  fastify.get('/category/details', async (request, reply) => {
    try {
      const { owner, category, year, db } = request.query;

      if (!owner || !category || !year || !db) {
        return reply.status(400).send({ error: 'Missing required parameters' });
      }

      // Get category data
      const { rows: categoryData } = await fastify.pg.query(
        'SELECT id, name FROM categories WHERE id = $1',
        [category],
      );

      if (!categoryData.length) {
        return reply.status(404).send({ error: 'Category not found' });
      }

      const prevStartDate = `${parseInt(year) - 1}-01-01`;
      const endDate = `${year}-12-31`;

      let ownerData;
      let transactions;

      // Check if we're requesting all accounts
      if (owner === 'all-accounts') {
        // For "all accounts", create a virtual owner
        ownerData = [{
          id: 'all-accounts',
          name: 'Tutti i conti',
          cc: '',
          iban: ''
        }];

        // Get all transactions for the specified category across all owners in this db
        const { rows: allTransactions } = await fastify.pg.query(`
        SELECT 
          t.id,
          to_char(t.date, 'YYYY-MM-DD') AS date,
          t.amount,
          t.subjectid,
          s.name AS subject_name,
          t.detailid,
          d.name AS detail_name,
          t.ownerid,
          o.name AS owner_name,
          o.cc AS owner_cc
        FROM 
          transactions t
        LEFT JOIN 
          subjects s ON t.subjectid = s.id
        LEFT JOIN 
          details d ON t.detailid = d.id
        LEFT JOIN
          owners o ON t.ownerid = o.id
        WHERE 
          t.db = $1
          AND t.categoryid = $2
          AND t.date >= $3
          AND t.date <= $4
        `, [db, category, prevStartDate, endDate]);

        transactions = allTransactions;
      } else {
        // Get owner data for a specific owner
        const { rows: specificOwnerData } = await fastify.pg.query(
          'SELECT id, name, cc, iban FROM owners WHERE id = $1',
          [owner],
        );

        if (!specificOwnerData.length) {
          return reply.status(404).send({ error: 'Owner not found' });
        }

        ownerData = specificOwnerData;

        // Get all transactions for the specified category and owner
        const { rows: ownerTransactions } = await fastify.pg.query(`
        SELECT 
          t.id,
          to_char(t.date, 'YYYY-MM-DD') AS date,
          t.amount,
          t.subjectid,
          s.name AS subject_name,
          t.detailid,
          d.name AS detail_name
        FROM 
          transactions t
        LEFT JOIN 
          subjects s ON t.subjectid = s.id
        LEFT JOIN 
          details d ON t.detailid = d.id
        WHERE 
          t.db = $1
          AND t.ownerid = $2
          AND t.categoryid = $3
          AND t.date >= $4
          AND t.date <= $5
        `, [db, owner, category, prevStartDate, endDate]);

        transactions = ownerTransactions;
      }

      // Initialize the report
      let report = {
        categoryId: category,
        categoryName: categoryData[0].name,
        year: year,
        prevYear: parseInt(year) - 1,
        owner: ownerData[0],
        totalIncome: 0,
        totalExpense: 0,
        monthlyTotals: {},
        subcategories: {}, // keeping the same property name for frontend compatibility
        summaryTable: [],
        averageMonthlyCosts: [],
        pieChartData: [],
      };

      // Initialize monthly totals
      for (let month = 1; month <= 12; month++) {
        report.monthlyTotals[month] = { income: 0, expense: 0, prevIncome: 0, prevExpense: 0 };
      }

      // Process transactions
      transactions.forEach(tx => {
        const txDate = new Date(tx.date);
        const month = txDate.getMonth() + 1;
        const amount = parseFloat(tx.amount) || 0;
        const isPrevYear = txDate.getFullYear() < parseInt(year);

        // Update monthly totals
        if (amount > 0) {
          // Arrotondiamo per maggiore precisione
          const amountRounded = parseFloat(amount.toFixed(2));
          if (isPrevYear) {
            report.monthlyTotals[month].prevIncome += amountRounded;
          } else {
            report.totalIncome += amountRounded;
            report.monthlyTotals[month].income += amountRounded;
          }
        } else {
          // Arrotondiamo per maggiore precisione
          const absAmount = parseFloat(Math.abs(amount).toFixed(2));
          if (isPrevYear) {
            report.monthlyTotals[month].prevExpense += absAmount;
          } else {
            report.totalExpense += absAmount;
            report.monthlyTotals[month].expense += absAmount;
          }
        }

        // Process subjects (replacing subcategories)
        if (tx.subjectid) {
          const subjectId = tx.subjectid;

          if (!report.subcategories[subjectId]) {
            report.subcategories[subjectId] = {
              id: subjectId,
              title: tx.subject_name, // Changed from subcategory.title
              totalIncome: 0,
              totalExpense: 0,
              monthlyDetails: {},
              values: [], // This will hold details
              transactionCount: 0,
            };

            for (let month = 1; month <= 12; month++) {
              report.subcategories[subjectId].monthlyDetails[month] = {
                income: 0,
                expense: 0,
                prevIncome: 0,
                prevExpense: 0,
              };
            }
          }

          // Update subject totals
          if (amount > 0) {
            // Arrotondiamo per maggiore precisione
            const amountRounded = parseFloat(amount.toFixed(2));
            if (isPrevYear) {
              report.subcategories[subjectId].monthlyDetails[month].prevIncome += amountRounded;
            } else {
              report.subcategories[subjectId].totalIncome += amountRounded;
              report.subcategories[subjectId].monthlyDetails[month].income += amountRounded;
            }
          } else {
            // Arrotondiamo per maggiore precisione
            const absAmount = parseFloat(Math.abs(amount).toFixed(2));
            if (isPrevYear) {
              report.subcategories[subjectId].monthlyDetails[month].prevExpense += absAmount;
            } else {
              report.subcategories[subjectId].totalExpense += absAmount;
              report.subcategories[subjectId].monthlyDetails[month].expense += absAmount;
            }
          }

          report.subcategories[subjectId].transactionCount++;

          // Add detail to values if not already present
          if (tx.detailid) {
            const detailId = tx.detailid;
            if (!report.subcategories[subjectId].values.some(v => v.id === detailId)) {
              report.subcategories[subjectId].values.push({
                id: detailId,
                title: tx.detail_name,
                detailsId: detailId,
              });
            }
          }
        }
      });

      // Generate summary table, average costs and pie chart data
      Object.values(report.subcategories).forEach(subject => {
        report.summaryTable.push({
          subcategory: subject.title, // Kept as 'subcategory' for frontend compatibility
          income: subject.totalIncome,
          expense: subject.totalExpense,
          difference: subject.totalIncome - subject.totalExpense,
        });

        // Find current year transactions for this subject
        const subjectTransactions = transactions.filter(tx =>
          tx.subjectid === subject.id &&
          parseFloat(tx.amount) < 0 &&
          new Date(tx.date).getFullYear() === parseInt(year),
        );

        // Get the last month with a transaction in the current year
        const lastTransactionMonth = subjectTransactions.length > 0
          ? Math.max(...subjectTransactions.map(tx => new Date(tx.date).getMonth() + 1))
          : 0;

        // Calculate number of months from January to the last transaction month
        // If no transactions found, average will be 0
        const monthCount = lastTransactionMonth > 0 ? lastTransactionMonth : 0;

        // Calculate average based on all months from January to last month with activity
        // Arrotondiamo per maggiore precisione
        const totalExpense = parseFloat(subject.totalExpense.toFixed(2));
        const averageCost = monthCount > 0 ? parseFloat((totalExpense / monthCount).toFixed(2)) : 0;
        const totalExpenseCost = totalExpense.toFixed(2);

        // Process details (values)
        subject.values = subject.values.map(value => {
          const relatedTransactions = transactions.filter(tx =>
            tx.detailid === value.id &&
            parseFloat(tx.amount) < 0 &&
            new Date(tx.date).getFullYear() === parseInt(year),
          );

          const totalExpense = relatedTransactions.reduce(
            (sum, tx) => sum + parseFloat(Math.abs(parseFloat(tx.amount)).toFixed(2)), 0,
          );

          // Get the last month with a transaction for this detail
          const lastMonth = relatedTransactions.length > 0
            ? Math.max(...relatedTransactions.map(tx => new Date(tx.date).getMonth() + 1))
            : 0;

          // Calculate months from January to the last transaction month
          const monthsCount = lastMonth > 0 ? lastMonth : 0;

          // Calculate average based on all months until the last transaction month
          // Arrotondiamo per maggiore precisione
          const avgCost = monthsCount > 0 ? parseFloat((totalExpense / monthsCount).toFixed(2)) : 0;

          return {
            ...value,
            averageCost: avgCost.toFixed(2),
            totalExpense: totalExpense.toFixed(2),
          };
        });

        report.averageMonthlyCosts.push({
          id: subject.id,
          category: subject.title,
          averageCost: averageCost.toFixed(2),
          totalExpense: totalExpenseCost,
          values: subject.values,
        });

        report.pieChartData.push({
          label: subject.title,
          value: subject.totalExpense,
        });
      });
      reply.send(report);
    } catch (error) {
      console.error(error);
      reply.status(500).send({ error: 'Internal Server Error' });
    }
  });

  fastify.post('/category/subject/details', async (request, reply) => {
    try {
      const { db, owner, category, subject, details, year } = request.body;

      if (!owner || !category || !subject || !details || !year || !db) {
        return reply.status(400).send({ error: "Missing required parameters" });
      }

      const currentYear = parseInt(year);
      const previousYear = currentYear - 1;

      const startDatePrevious = `${previousYear}-01-01`;
      const endDateCurrent = `${currentYear}-12-31`;

      // Get detail info
      const { rows: detailInfo } = await fastify.pg.query(
        'SELECT id, name FROM details WHERE id = $1',
        [details]
      );

      if (!detailInfo.length) {
        return reply.status(404).send({ error: "Detail not found" });
      }

      let transactions;

      // Check if we're requesting all accounts
      if (owner === 'all-accounts') {
        // Retrieve transactions for all owners
        const { rows: allTransactions } = await fastify.pg.query(`
        SELECT
          t.id,
          to_char(t.date, 'YYYY-MM-DD') AS date,
          t.amount,
          t.detailid,
          d.name AS detail_name,
          EXTRACT(MONTH FROM t.date) AS month,
          EXTRACT(YEAR FROM t.date) AS year,
          t.ownerid,
          o.name AS owner_name,
          o.cc AS owner_cc
        FROM
          transactions t
        LEFT JOIN
          details d ON t.detailid = d.id
        LEFT JOIN
          owners o ON t.ownerid = o.id
        WHERE
          t.db = $1
          AND t.categoryid = $2
          AND t.subjectid = $3
          AND t.detailid = $4
          AND t.date >= $5
          AND t.date <= $6
        `, [db, category, subject, details, startDatePrevious, endDateCurrent]);

        transactions = allTransactions;
      } else {
        // Retrieve transactions for a specific owner
        const { rows: ownerTransactions } = await fastify.pg.query(`
        SELECT
          t.id,
          to_char(t.date, 'YYYY-MM-DD') AS date,
          t.amount,
          t.detailid,
          d.name AS detail_name,
          EXTRACT(MONTH FROM t.date) AS month,
          EXTRACT(YEAR FROM t.date) AS year
        FROM
          transactions t
        LEFT JOIN
          details d ON t.detailid = d.id
        WHERE
          t.db = $1
          AND t.ownerid = $2
          AND t.categoryid = $3
          AND t.subjectid = $4
          AND t.detailid = $5
          AND t.date >= $6
          AND t.date <= $7
        `, [db, owner, category, subject, details, startDatePrevious, endDateCurrent]);

        transactions = ownerTransactions;
      }

      // Initialize report
      let report = {
        details: {
          id: details,
          title: detailInfo[0].name,
          averageCost: 0,     // Will store monthly average expense
          totalExpense: 0     // Will store total annual expense
        },
        categoryId: category,
        subjectId: subject,
        year: currentYear,
        prevYear: previousYear,
        totalIncome: 0,
        totalExpense: 0,
        monthlyTotals: {},
      };

      // Initialize monthly totals
      for (let month = 1; month <= 12; month++) {
        report.monthlyTotals[month] = { income: 0, expense: 0, prevIncome: 0, prevExpense: 0 };
      }


      // Process transactions
      let currentYearExpenses = 0;
      let lastExpenseMonth = 0;

      transactions.forEach(tx => {
        const month = parseInt(tx.month);
        const txYear = parseInt(tx.year);
        const amount = parseFloat(tx.amount) || 0;
        const isPrevYear = txYear === previousYear;

        // Aggregate income and expenses
        if (amount > 0) {
          // Arrotondiamo per maggiore precisione
          const amountRounded = parseFloat(amount.toFixed(2));
          if (isPrevYear) {
            report.monthlyTotals[month].prevIncome += amountRounded;
          } else {
            report.totalIncome += amountRounded;
            report.monthlyTotals[month].income += amountRounded;
          }
        } else {
          // Arrotondiamo per maggiore precisione
          const absAmount = parseFloat(Math.abs(amount).toFixed(2));
          if (isPrevYear) {
            report.monthlyTotals[month].prevExpense += absAmount;
          } else {
            report.totalExpense += absAmount;
            report.monthlyTotals[month].expense += absAmount;

            // Track current year expense details
            currentYearExpenses += absAmount;
            lastExpenseMonth = Math.max(lastExpenseMonth, month);
          }
        }
      });

      // Calculate average monthly expense
      // Divide by the number of months from January to the last month with a transaction
      const currentYearExpensesRounded = parseFloat(currentYearExpenses.toFixed(2));
      const avgMonthlyExpense = lastExpenseMonth > 0 
        ? parseFloat((currentYearExpensesRounded / lastExpenseMonth).toFixed(2)) 
        : 0;

      // Update the details object with calculated values
      report.details.averageCost = avgMonthlyExpense.toFixed(2);
      report.details.totalExpense = currentYearExpensesRounded.toFixed(2);

      reply.send(report);
    } catch (error) {
      console.error("Error in category/subject/details:", error);
      reply.status(500).send({ error: "Internal Server Error" });
    }
  });

  fastify.post('/category/subject/details/chart', async (request, reply) => {
    try {
      const { subject, category, year, owner, db } = request.body;

      // Validate inputs
      if (!subject || !category || !year || !owner || !db) {
        return reply.code(400).send({ error: 'Missing required parameters' });
      }

      // Get current year and previous year transactions for this subject and category
      const currentYear = parseInt(year);
      const prevYear = currentYear - 1;

      // First, get the subject name
      const { rows: subjectData } = await fastify.pg.query(
        'SELECT id, name FROM subjects WHERE id = $1',
        [subject]
      );

      const subjectName = subjectData.length > 0 ? subjectData[0].name : `Subject ${subject}`;

      let rows;

      // Check if we're requesting all accounts
      if (owner === 'all-accounts') {
        // For all accounts, we need to get transactions for all owners
        const allAccountsQuery = `
        SELECT
          t.detailid as detail_id,
          d.name as detail_name,
          EXTRACT(MONTH FROM t.date) as month,
          EXTRACT(YEAR FROM t.date) as year,
          SUM(t.amount) as amount,
          t.ownerid,
          o.name as owner_name,
          o.cc as owner_cc
        FROM transactions t
        JOIN details d ON t.detailid = d.id
        JOIN owners o ON t.ownerid = o.id
        WHERE
          t.subjectid = $1 AND
          t.categoryid = $2 AND
          EXTRACT(YEAR FROM t.date) IN ($3, $4) AND
          t.amount < 0 AND
          t.db = $5
        GROUP BY t.detailid, d.name, EXTRACT(MONTH FROM t.date), EXTRACT(YEAR FROM t.date), t.ownerid, o.name, o.cc
        ORDER BY t.detailid, EXTRACT(YEAR FROM t.date), EXTRACT(MONTH FROM t.date)
        `;

        const { rows: allAccountsRows } = await fastify.pg.query(allAccountsQuery, [subject, category, prevYear, currentYear, db]);
        rows = allAccountsRows;
      } else {
        // For a specific owner, use the original query
        const specificOwnerQuery = `
        SELECT
          t.detailid as detail_id,
          d.name as detail_name,
          EXTRACT(MONTH FROM t.date) as month,
          EXTRACT(YEAR FROM t.date) as year,
          SUM(t.amount) as amount
        FROM transactions t
        JOIN details d ON t.detailid = d.id
        WHERE
          t.subjectid = $1 AND
          t.categoryid = $2 AND
          t.ownerid = $3 AND
          EXTRACT(YEAR FROM t.date) IN ($4, $5) AND
          t.amount < 0 AND
          t.db = $6
        GROUP BY t.detailid, d.name, EXTRACT(MONTH FROM t.date), EXTRACT(YEAR FROM t.date)
        ORDER BY t.detailid, EXTRACT(YEAR FROM t.date), EXTRACT(MONTH FROM t.date)
        `;

        const { rows: specificOwnerRows } = await fastify.pg.query(specificOwnerQuery, [subject, category, owner, prevYear, currentYear, db]);
        rows = specificOwnerRows;
      }

      // Get all unique details
      const detailsSet = new Set();
      rows.forEach(row => detailsSet.add(row.detail_id));

      // Create series structure for grouped-stacked chart
      const currentYearSeries = [];
      const prevYearSeries = [];

      detailsSet.forEach(detailId => {
        // Filter rows for this detail
        const detailRows = rows.filter(row => row.detail_id === detailId);
        const detailName = detailRows.length > 0 ? detailRows[0].detail_name : `Detail ${detailId}`;

        // Initialize month data arrays
        const currentYearData = Array(12).fill(0);
        const prevYearData = Array(12).fill(0);

        // Fill in data from rows
        detailRows.forEach(row => {
          const monthIndex = parseInt(row.month) - 1;
          const amount = Math.abs(parseFloat(row.amount));
          const rowYear = parseInt(row.year);

          if (rowYear === currentYear) {
            currentYearData[monthIndex] = parseFloat(amount.toFixed(2));
          } else {
            prevYearData[monthIndex] = parseFloat(amount.toFixed(2));
          }
        });

        // Add series for current year
        currentYearSeries.push({
          name: detailName,
          data: currentYearData
        });

        // Add series for previous year
        prevYearSeries.push({
          name: detailName,
          data: prevYearData
        });
      });

      reply.code(200).send({ subject, subjectName, category, currentYear, prevYear, currentYearSeries, prevYearSeries })
    } catch (error) {
      console.error('Error fetching chart data:', error);
      return reply.code(500).send({ error: 'Internal Server Error' });
    }
  });
};

export default report;

// Aggiungiamo un commento per documentare il comportamento del master report
// Il master report fornisce dati aggiornati ogni volta che viene chiamato, senza cache
// È importante che i client aggiornino regolarmente questi dati per avere una visione sempre aggiornata
