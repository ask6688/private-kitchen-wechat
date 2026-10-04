module.exports = () => Array.from({ length: 18 }, (_, i) => ({ id: i,
  left: 8 + i * 4.8, drift: (i % 2 ? 1 : -1) * (16 + i % 4 * 12), delay: i % 4 * 45,
  color: ['#D9DFB1', '#E5CAA3', '#C6D8C5', '#E7D6BC'][i % 4] }))
