/**
 * Backend utility functions for expense calculations
 * Centralizes calculation logic to ensure consistency across all endpoints
 */

/**
 * Calculate monthly average expense based on transaction data
 * @param {Array} transactions - Array of transaction objects
 * @param {number} year - Current year
 * @returns {Object} - Object containing totalExpense, lastMonthWithExpense, and averageExpense
 */
function calculateMonthlyAverageExpense(transactions, year) {
  if (!transactions || transactions.length === 0) {
    return {
      totalExpense: 0,
      lastMonthWithExpense: 0,
      averageExpense: 0
    };
  }

  const currentYear = parseInt(year, 10);
  let totalExpense = 0;
  let lastExpenseMonth = 0;

  // Process transactions to calculate totals and find last month with expenses
  transactions.forEach(tx => {
    const amount = parseFloat(tx.amount);
    const transactionDate = new Date(tx.date);
    const transactionYear = transactionDate.getFullYear();
    const month = transactionDate.getMonth() + 1; // Convert to 1-based month

    // Only consider expense transactions (negative amounts) for the current year
    if (amount < 0 && transactionYear === currentYear) {
      const absAmount = Math.abs(amount);
      totalExpense += absAmount;
      lastExpenseMonth = Math.max(lastExpenseMonth, month);
    }
  });

  // Round total expense to 2 decimal places
  const totalExpenseRounded = parseFloat(totalExpense.toFixed(2));
  
  // Calculate average: totalExpense / lastMonthWithExpense
  const averageExpense = lastExpenseMonth > 0 
    ? parseFloat((totalExpenseRounded / lastExpenseMonth).toFixed(2)) 
    : 0;

  return {
    totalExpense: totalExpenseRounded,
    lastMonthWithExpense: lastExpenseMonth,
    averageExpense
  };
}

/**
 * Calculate monthly average from monthly aggregated data
 * @param {Object} monthlyData - Object with month keys and expense values
 * @returns {Object} - Object containing totalExpense, lastMonthWithExpense, and averageExpense
 */
function calculateAverageFromMonthlyData(monthlyData) {
  if (!monthlyData || typeof monthlyData !== 'object') {
    return {
      totalExpense: 0,
      lastMonthWithExpense: 0,
      averageExpense: 0
    };
  }

  let totalExpense = 0;
  let lastExpenseMonth = 0;

  // Process monthly data
  Object.entries(monthlyData).forEach(([monthStr, data]) => {
    const month = parseInt(monthStr, 10);
    const expense = parseFloat(data.expense || 0);

    if (expense > 0) {
      totalExpense += expense;
      lastExpenseMonth = Math.max(lastExpenseMonth, month);
    }
  });

  // Round total expense to 2 decimal places
  const totalExpenseRounded = parseFloat(totalExpense.toFixed(2));
  
  // Calculate average
  const averageExpense = lastExpenseMonth > 0 
    ? parseFloat((totalExpenseRounded / lastExpenseMonth).toFixed(2)) 
    : 0;

  return {
    totalExpense: totalExpenseRounded,
    lastMonthWithExpense: lastExpenseMonth,
    averageExpense
  };
}

/**
 * Validate calculation parameters
 * @param {Object} params - Parameters to validate
 * @returns {Object} - Validation result
 */
function validateCalculationParams(params) {
  const { year, owner, db } = params;
  
  const errors = [];
  
  if (!year || isNaN(parseInt(year, 10))) {
    errors.push('Year must be a valid number');
  }
  
  if (!owner) {
    errors.push('Owner parameter is required');
  }
  
  if (!db) {
    errors.push('Database parameter is required');
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Log calculation details for debugging
 * @param {string} context - Context of the calculation
 * @param {Object} data - Calculation data
 */
function logCalculationDetails(context, data) {
  console.log(`[${context}] Calculation Details:`, {
    totalExpense: data.totalExpense,
    lastMonthWithExpense: data.lastMonthWithExpense,
    averageExpense: data.averageExpense,
    formula: `${data.totalExpense} / ${data.lastMonthWithExpense} = ${data.averageExpense}`
  });
}

module.exports = {
  calculateMonthlyAverageExpense,
  calculateAverageFromMonthlyData,
  validateCalculationParams,
  logCalculationDetails
};
