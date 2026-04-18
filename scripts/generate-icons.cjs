const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const SOURCE = path.resolve(__dirname, '..', 'requii_new_logo.png');
const BUILD_DIR = path.resolve(__dirname, '..', 'build');

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

// Build a valid ICO file from an array of {size, pngBuffer} entries
function buildIco(entries) {
    const headerSize = 6;
    const dirEntrySize = 16;
    const dirSize = dirEntrySize * entries.length;
    let dataOffset = headerSize + dirSize;

    // ICO header: reserved=0, type=1 (icon), count
    const header = Buffer.alloc(headerSize);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(entries.length, 4);

    const dirEntries = [];
    const imageDataParts = [];

    for (const { size, pngBuffer } of entries) {
        const entry = Buffer.alloc(dirEntrySize);
        entry.writeUInt8(size >= 256 ? 0 : size, 0);   // width (0 = 256)
        entry.writeUInt8(size >= 256 ? 0 : size, 1);   // height
        entry.writeUInt8(0, 2);                          // color palette
        entry.writeUInt8(0, 3);                          // reserved
        entry.writeUInt16LE(1, 4);                       // color planes
        entry.writeUInt16LE(32, 6);                      // bits per pixel
        entry.writeUInt32LE(pngBuffer.length, 8);        // image data size
        entry.writeUInt32LE(dataOffset, 12);             // offset to image data
        dirEntries.push(entry);
        imageDataParts.push(pngBuffer);
        dataOffset += pngBuffer.length;
    }

    return Buffer.concat([header, ...dirEntries, ...imageDataParts]);
}

async function main() {
    if (!fs.existsSync(SOURCE)) {
        throw new Error(`Source logo not found: ${SOURCE}`);
    }

    const metadata = await sharp(SOURCE).metadata();
    console.log(`Source: ${metadata.width}x${metadata.height} ${metadata.format}`);

    const maxDim = Math.max(metadata.width, metadata.height);

    // Create a square PNG by extending with transparent padding
    const squareBuffer = await sharp(SOURCE)
        .resize(maxDim, maxDim, {
            fit: 'contain',
            background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .png()
        .toBuffer();

    // Save as icon.png and icon-macos.png
    fs.writeFileSync(path.join(BUILD_DIR, 'icon.png'), squareBuffer);
    fs.writeFileSync(path.join(BUILD_DIR, 'icon-macos.png'), squareBuffer);
    console.log(`Saved icon.png and icon-macos.png (${maxDim}x${maxDim})`);

    // Generate sized PNGs for ICO
    const icoEntries = [];
    for (const size of ICO_SIZES) {
        const buf = await sharp(squareBuffer)
            .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .png()
            .toBuffer();
        icoEntries.push({ size, pngBuffer: buf });
        console.log(`  Generated ${size}x${size} PNG (${buf.length} bytes)`);
    }

    // Build and save ICO
    const icoBuffer = buildIco(icoEntries);
    fs.writeFileSync(path.join(BUILD_DIR, 'icon.ico'), icoBuffer);
    console.log(`Saved icon.ico (${icoBuffer.length} bytes, ${icoEntries.length} images)`);

    // Verify icon.png has visible content
    const stats = await sharp(path.join(BUILD_DIR, 'icon.png')).stats();
    const hasContent = stats.channels.some(ch => ch.max > 0);
    console.log(`\nVerification: icon.png hasVisibleContent=${hasContent}`);
    if (!hasContent) {
        throw new Error('Generated icon.png has no visible content!');
    }
}

main().catch(err => { console.error(err); process.exit(1); });
