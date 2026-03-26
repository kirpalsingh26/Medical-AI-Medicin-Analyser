export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#ecfeff',
          500: '#06b6d4',
          700: '#0e7490'
        }
      },
      boxShadow: {
        glow: '0 0 40px rgba(6,182,212,0.25)'
      }
    }
  },
  plugins: []
};