import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL });

const testTransactions = [
  // Test con transazioni che dovrebbero matchare regole
  { description: "COMMISSIONI SU PAGAMENTO", amount: -0.60, expected_method: "rule" },
  { description: "VODAFONE IT ABBONATO", amount: -29.90, expected_method: "rule" },
  { description: "PAYPAL EUROPE SARL", amount: -15.50, expected_method: "rule" },
  
  // Test con transazioni per semantic search
  { description: "BONIFICO A FAVORE DI ROSSI MARIO", amount: -1500, expected_method: "semantic" },
  { description: "STIPENDIO MENSILE", amount: 2500, expected_method: "semantic" },
];

async function testClassification() {
  console.log("🧪 Testing Classification Accuracy\n");
  
  for (const [i, tx] of testTransactions.entries()) {
    try {
      const response = await fetch('http://localhost:9000/v1/classification/classify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          db: 'db1',
          transaction: {
            id: `test-${i}`,
            description: tx.description,
            amount: tx.amount,
            date: '2026-02-11'
          }
        })
      });
      
      const result = await response.json();
      
      if (result.success && result.classification) {
        const match = result.classification.method === tx.expected_method ? '✅' : '❌';
        console.log(`${match} Test ${i + 1}: ${tx.description.substring(0, 40)}`);
        console.log(`   Method: ${result.classification.method} (expected: ${tx.expected_method})`);
        console.log(`   Category: ${result.classification.category_name} / ${result.classification.subject_name}`);
        console.log(`   Confidence: ${result.classification.confidence}%`);
        console.log(`   Latency: ${result.latency_ms}ms\n`);
      } else {
        console.log(`❌ Test ${i + 1}: Failed - ${result.error || 'No classification'}\n`);
      }
    } catch (error) {
      console.log(`❌ Test ${i + 1}: Error - ${error.message}\n`);
    }
  }
  
  pool.end();
}

testClassification();
