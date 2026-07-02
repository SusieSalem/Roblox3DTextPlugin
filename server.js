const express = require('express');
const cors = require('cors');
const opentype = require('opentype.js');
const earcut = require('earcut');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const FONT_PATH_OTF = path.join(__dirname, 'fonts', 'NotoSansCJK.otf');
const FONT_PATH_TTF = path.join(__dirname, 'fonts', 'NotoSansCJK.ttf');
let FONT_PATH = FONT_PATH_OTF;

if (fs.existsSync(FONT_PATH_TTF)) {
    FONT_PATH = FONT_PATH_TTF;
} else if (!fs.existsSync(FONT_PATH_OTF)) {
    console.warn(`[WARNING] Font file not found. Please add a CJK font to the fonts folder.`);
}

let font = null;

try {
    if (fs.existsSync(FONT_PATH)) {
        font = opentype.loadSync(FONT_PATH);
        console.log("Font loaded successfully from:", FONT_PATH);
    }
} catch (e) {
    console.error("Failed to load font:", e);
}

app.get('/', (req, res) => {
    res.json({
        status: "alive",
        fontLoaded: font !== null,
        message: "3D Text API is running successfully!"
    });
});

// Helper to sample curves into straight lines
function samplePath(commands, resolution = 3) {
    let contours = [];
    let currentContour = [];
    
    let curX = 0, curY = 0;
    
    for (let cmd of commands) {
        if (cmd.type === 'M') {
            if (currentContour.length > 0) {
                contours.push(currentContour);
            }
            currentContour = [{x: cmd.x, y: cmd.y}];
            curX = cmd.x; curY = cmd.y;
        } else if (cmd.type === 'L') {
            currentContour.push({x: cmd.x, y: cmd.y});
            curX = cmd.x; curY = cmd.y;
        } else if (cmd.type === 'Q') {
            // Quadratic Bezier
            for (let i = 1; i <= resolution; i++) {
                let t = i / resolution;
                let t2 = 1 - t;
                let nx = t2*t2*curX + 2*t2*t*cmd.x1 + t*t*cmd.x;
                let ny = t2*t2*curY + 2*t2*t*cmd.y1 + t*t*cmd.y;
                currentContour.push({x: nx, y: ny});
            }
            curX = cmd.x; curY = cmd.y;
        } else if (cmd.type === 'C') {
            // Cubic Bezier
            for (let i = 1; i <= resolution; i++) {
                let t = i / resolution;
                let t2 = 1 - t;
                let nx = t2*t2*t2*curX + 3*t2*t2*t*cmd.x1 + 3*t2*t*t*cmd.x2 + t*t*t*cmd.x;
                let ny = t2*t2*t2*curY + 3*t2*t2*t*cmd.y1 + 3*t2*t*t*cmd.y2 + t*t*t*cmd.y;
                currentContour.push({x: nx, y: ny});
            }
            curX = cmd.x; curY = cmd.y;
        } else if (cmd.type === 'Z') {
            if (currentContour.length > 0) {
                // Close path by not repeating the first point, but mark as closed
                contours.push(currentContour);
                currentContour = [];
            }
        }
    }
    if (currentContour.length > 0) {
        contours.push(currentContour);
    }
    return contours;
}

// Calculate signed area to determine winding order
function signedArea(contour) {
    let area = 0;
    for (let i = 0; i < contour.length; i++) {
        let j = (i + 1) % contour.length;
        area += contour[i].x * contour[j].y - contour[j].x * contour[i].y;
    }
    return area / 2;
}

// Ray-casting algorithm for point in polygon
function pointInPolygon(point, polygon) {
    let x = point.x, y = point.y;
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        let xi = polygon[i].x, yi = polygon[i].y;
        let xj = polygon[j].x, yj = polygon[j].y;
        let intersect = ((yi > y) != (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

app.post('/generate', (req, res) => {
    if (!font) {
        return res.status(500).json({ error: "Font not loaded on server." });
    }

    const text = req.body.text || "Hello";
    const depth = req.body.depth || 10;
    const curveRes = req.body.resolution || 5;

    // Get Opentype path
    const fontPath = font.getPath(text, 0, 0, 72);
    const contours = samplePath(fontPath.commands, curveRes);

    // Filter out degenerate contours
    const validContours = contours.filter(c => c.length >= 3);

    let outers = [];
    let holes = [];

    // Separate based on winding order
    // In many fonts, CW is outer (>0), CCW is hole (<0) (or vice versa, opentype often uses CCW for outer)
    // Actually, let's just group them by checking point inside polygon
    validContours.forEach(c => {
        c.area = signedArea(c);
        c.isCCW = c.area < 0;
    });

    // We assume larger absolute area or specific winding is outer.
    // Standard TrueType: CW is outer. OpenType/CFF: CCW is outer. 
    // To be safe, any contour that is NOT inside any other contour is an outer contour.
    validContours.forEach(c1 => {
        let isInsideAnother = false;
        let pt = c1[0];
        validContours.forEach(c2 => {
            if (c1 !== c2 && Math.abs(c2.area) > Math.abs(c1.area)) {
                if (pointInPolygon(pt, c2)) {
                    // Check if they have opposite winding orders, usually they alternate
                    if ((c1.area > 0) !== (c2.area > 0)) {
                        isInsideAnother = true;
                    }
                }
            }
        });
        if (!isInsideAnother) {
            outers.push({ path: c1, holes: [] });
        } else {
            holes.push(c1);
        }
    });

    // Assign holes to the smallest outer contour that contains them
    holes.forEach(h => {
        let parent = null;
        let minArea = Infinity;
        outers.forEach(o => {
            if (pointInPolygon(h[0], o.path)) {
                if (Math.abs(o.path.area) < minArea) {
                    minArea = Math.abs(o.path.area);
                    parent = o;
                }
            }
        });
        if (parent) {
            parent.holes.push(h);
        }
    });

    let globalVertices = []; // [x, y, z]
    let globalIndices = [];
    let vertexOffset = 0;

    // Triangulate each outer shape (and its holes)
    outers.forEach(shape => {
        let flatCoords = [];
        let holeIndices = [];
        let vertCount = 0;

        // Add outer path
        shape.path.forEach(p => {
            flatCoords.push(p.x, -p.y); // flip Y for 3D coordinates
            vertCount++;
        });

        // Add holes
        shape.holes.forEach(h => {
            holeIndices.push(vertCount);
            h.forEach(p => {
                flatCoords.push(p.x, -p.y);
                vertCount++;
            });
        });

        // Triangulate 2D
        const triangles = earcut(flatCoords, holeIndices, 2);

        // Extrude to 3D
        const startVertexOffset = globalVertices.length / 3;

        // 1. Create Front and Back vertices
        for (let i = 0; i < flatCoords.length; i += 2) {
            let vx = flatCoords[i];
            let vy = flatCoords[i+1];
            // Front face (Z = depth/2)
            globalVertices.push(vx, vy, depth / 2);
        }
        for (let i = 0; i < flatCoords.length; i += 2) {
            let vx = flatCoords[i];
            let vy = flatCoords[i+1];
            // Back face (Z = -depth/2)
            globalVertices.push(vx, vy, -depth / 2);
        }

        // 2. Add Front indices
        for (let i = 0; i < triangles.length; i += 3) {
            let v1 = triangles[i];
            let v2 = triangles[i+1];
            let v3 = triangles[i+2];
            // Fix winding for front (make sure normals face out)
            globalIndices.push(startVertexOffset + v1, startVertexOffset + v2, startVertexOffset + v3);
        }

        // 3. Add Back indices (reversed winding)
        const backOffset = vertCount;
        for (let i = 0; i < triangles.length; i += 3) {
            let v1 = triangles[i];
            let v2 = triangles[i+1];
            let v3 = triangles[i+2];
            globalIndices.push(
                startVertexOffset + backOffset + v1,
                startVertexOffset + backOffset + v3, // swap v2 and v3
                startVertexOffset + backOffset + v2
            );
        }

        // 4. Create Side faces (connecting front and back boundaries)
        // We need to connect the edges of the outer path and the holes
        let currentBoundaryStart = 0;
        let boundaries = [shape.path.length]; // lengths of [outer, hole1, hole2, ...]
        shape.holes.forEach(h => boundaries.push(h.length));

        boundaries.forEach(bLen => {
            for (let i = 0; i < bLen; i++) {
                let current = currentBoundaryStart + i;
                let next = currentBoundaryStart + ((i + 1) % bLen);

                let front1 = startVertexOffset + current;
                let front2 = startVertexOffset + next;
                let back1 = startVertexOffset + backOffset + current;
                let back2 = startVertexOffset + backOffset + next;

                // Two triangles for the quad edge
                globalIndices.push(front1, back1, front2);
                globalIndices.push(back1, back2, front2);
            }
            currentBoundaryStart += bLen;
        });
    });

    // Scale down a bit as font units are huge (e.g. 1000s)
    for(let i=0; i<globalVertices.length; i++) {
        globalVertices[i] *= 0.1; 
    }

    res.json({
        vertices: globalVertices,
        indices: globalIndices
    });
});

if (require.main === module) {
    const PORT = 3000;
    app.listen(PORT, () => {
        console.log(`3D Text API running on port ${PORT}`);
    });
}

module.exports = app;
