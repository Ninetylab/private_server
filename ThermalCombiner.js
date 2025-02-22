/**
 * Combines two 8×8 matrices into a single 8×16 matrix by concatenating each row.
 *
 * @param {number[][]} imager1 - First 8×8 matrix.
 * @param {number[][]} imager2 - Second 8×8 matrix.
 * @returns {number[][] | null} An 8×16 combined matrix, or null if the input is invalid.
 */
function combineThermalData(imager1, imager2) {
    // Only log validation errors
    if (
        !Array.isArray(imager1) || !Array.isArray(imager2) ||
        imager1.length !== 8 || imager2.length !== 8
    ) {
        console.error('[ThermalCombiner] Invalid input: each imager must be an 8x8 array.');
        return null;
    }

    const combinedMatrix = [];
    for (let row = 0; row < 8; row++) {
        if (
            !Array.isArray(imager1[row]) || imager1[row].length !== 8 ||
            !Array.isArray(imager2[row]) || imager2[row].length !== 8
        ) {
            console.error(`[ThermalCombiner] Invalid row ${row}: each row must contain 8 elements.`);
            return null;
        }
        // Concatenate corresponding rows from both imagers
        const combinedRow = [...imager1[row], ...imager2[row]];
        combinedMatrix.push(combinedRow);
    }

    return combinedMatrix;
}

/**
 * Transforms a 2D matrix (e.g., 8×16) into a one-dimensional array of data points
 * that is suitable for an ECharts heatmap series.
 *
 * Each data point is of the form: [x, y, value], where:
 *   - x is the column index,
 *   - y is the row index,
 *   - value is the temperature (or other sensor reading).
 *
 * @param {number[][]} matrix - The 2D matrix to transform.
 * @returns {Array} The transformed data array.
 */
function transformCombinedToHeatmapData(matrix) {
    if (!Array.isArray(matrix) || matrix.length === 0) {
        console.error('[ThermalCombiner] Invalid matrix provided for transformation.');
        return [];
    }

    const heatmapData = [];
    for (let y = 0; y < matrix.length; y++) {
        const row = matrix[y];
        for (let x = 0; x < row.length; x++) {
            heatmapData.push([x, y, row[x]]);
        }
    }
    
    return heatmapData;
}

module.exports = {
    combineThermalData,
    transformCombinedToHeatmapData
};
