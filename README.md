# 3D Text Generation API

This is the backend server that powers the Roblox 3D Text Plugin. 
It uses `opentype.js` to parse font files and `earcut` to triangulate the 2D characters into 3D meshes.

## Setup Instructions

1. **Install Node.js**: You need to have Node.js installed on your computer. Download it from [nodejs.org](https://nodejs.org/).
2. **Install Dependencies**: Open a terminal/command prompt in this `Text3DAPI` folder and run:
   ```bash
   npm install
   ```
3. **Add a Font**: 
   - We need a font file that supports Chinese/Japanese.
   - Download **Noto Sans CJK** (or any `.otf`/`.ttf` font you prefer).
   - Create a `fonts` folder inside this directory.
   - Place your font file in the `fonts` folder and rename it to `NotoSansCJK.otf` (or update `server.js` with the correct filename).
4. **Run the Server**:
   ```bash
   npm start
   ```
   The server will start on `http://localhost:3000`.

## API Endpoint

**POST `/generate`**
- **Body (JSON)**: `{"text": "Hello 世界", "depth": 1.0}`
- **Response**: Returns a JSON object with `vertices` (flat array of x,y,z) and `indices` (flat array of triangle vertex indices) which the Roblox plugin uses to build an EditableMesh.
