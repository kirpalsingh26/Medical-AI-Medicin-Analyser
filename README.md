# MedVision

Production-grade AI-powered pharmaceutical system built with MERN + OCR + Gemini.

## Features

- Image OCR medicine detection
- Voice input (multi-language)
- Barcode scanner
- Prescription scanner (multi-medicine detection)
- AI insights generation with retry logic
- Medicine comparison and alternative suggestions
- AI chatbot assistant
- Smart search autocomplete
- JWT authentication
- Search history + user dashboard
- Analytics dashboard
- Caching, rate limiting, logging, and robust error handling
- PWA offline support
- Confidence scoring for OCR
- Dark mode + modern UI animations (Framer Motion)

## Tech

- Frontend: React, Tailwind CSS, Framer Motion, Vite, PWA
- Backend: Node.js, Express, MongoDB, Tesseract.js, Gemini API

## Setup

1. Install dependencies:
   - `npm install`
2. Copy environment file:
   - `cp .env.example .env`
3. Configure values in `.env`:
   - `MONGO_URI`
   - `JWT_SECRET`
   - `GEMINI_API_KEY`
4. Seed starter medicine data:
   - `npm run seed -w backend`
   - For expanded Indian medicine catalog: `npm run seed:india -w backend`
   - For large custom imports: `npm run import:csv -w backend -- ./backend/src/data/medicines.india.seed.csv`
5. Start development:
   - `npm run dev`

Frontend: http://localhost:5173  
Backend: http://localhost:5001

## Build for Production

- `npm run build`
- `npm run start`

## API Highlights

- Auth
  - `POST /api/auth/register`
  - `POST /api/auth/login`
  - `GET /api/auth/me`
- Medicines
  - `GET /api/medicines/search?q=...`
  - `GET /api/medicines/autocomplete?q=...`
  - `GET /api/medicines/barcode?barcode=...`
  - `POST /api/medicines/ocr-scan`
  - `POST /api/medicines/compare`
- AI
  - `POST /api/ai/insights`
  - `POST /api/ai/alternatives`
  - `POST /api/ai/chat`

## Folder Structure

```
medvision/
├── backend/
│   └── src/
│       ├── config/
│       ├── controllers/
│       ├── data/
│       ├── middleware/
│       ├── models/
│       ├── routes/
│       ├── scripts/
│       ├── services/
│       └── utils/
├── frontend/
│   └── src/
│       ├── api/
│       ├── components/
│       ├── context/
│       ├── hooks/
│       └── pages/
└── README.md
```
