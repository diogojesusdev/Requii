const fs = require('fs');
const path = require('path');
const { rcedit } = require('rcedit');

module.exports = async function afterPack(context) {
    if (context.electronPlatformName !== 'win32') {
        return;
    }

    const productFilename = context.packager.appInfo.productFilename;
    const exePath = path.join(context.appOutDir, `${productFilename}.exe`);
    const iconPath = path.join(context.packager.projectDir, 'build', 'icon.ico');

    if (!fs.existsSync(exePath)) {
        throw new Error(`Windows executable not found for icon update: ${exePath}`);
    }

    if (!fs.existsSync(iconPath)) {
        throw new Error(`Windows icon file not found for icon update: ${iconPath}`);
    }

    await rcedit(exePath, { icon: iconPath });
    console.log(`[afterPack] Applied icon to ${exePath}`);
};
