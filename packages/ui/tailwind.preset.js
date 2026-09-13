/** @type {import('tailwindcss').Config} */
module.exports = {
  theme: {
    extend: {
      colors: {
        brand: {
          bg: "#F5F5F0",
          navy: "#002855",
          red: "#D97706",
          cream: "#FAF9F6",
          ink: "#334155",
        },
        cockpit: {
          bg: "#F5F5F0",
          card: "#FAF9F6",
          border: "#E8E8E1",
          gold: "#D97706",
        },
        royal: {
          blue: "#002855",
          navy: "#334155",
        },
        amber: {
          accent: "#D97706",
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        "4xl": "2rem",
        "5xl": "2.5rem",
      },
    },
  },
};
