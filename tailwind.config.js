/** @type {import('tailwindcss').Config} */
export default {
    content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
    theme: {
        extend: {
            colors: {
                ink: '#04131e',
                paper: '#f5efe5',
                ember: '#ff6b35',
                sea: '#1a7f8e',
                moss: '#3a6b35',
            },
            boxShadow: {
                panel: '0 24px 80px rgba(4, 19, 30, 0.16)',
            },
        },
    },
    plugins: [],
};