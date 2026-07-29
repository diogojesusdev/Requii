const fs = require('fs');
const path = require('path');

function resolveRcedit() {
    try {
        const loaded = require('rcedit');
        if (typeof loaded === 'function') {
            return loaded;
        }

        if (loaded && typeof loaded.rcedit === 'function') {
            return loaded.rcedit;
        }
    } catch (error) {
        if (error && error.code === 'MODULE_NOT_FOUND' && error.message.includes("'rcedit'")) {
            return null;
        }

        throw error;
    }

    throw new Error('The rcedit module was loaded, but no callable export was found.');
}

module.exports = async function afterPack(context) {
    if (context.electronPlatformName !== 'win32') {
        return;
    }

    const rcedit = resolveRcedit();
    if (!rcedit) {
        console.warn('[afterPack] Skipping Windows icon patch because module "rcedit" is not installed.');
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

    const rcedit = resolveRcedit();
    if (!rcedit) {
        console.warn('[afterPack] Skipping Windows icon patch because module "rcedit" is not installed.');
        return;
    }

    await rcedit(exePath, { icon: iconPath });
    console.log(`[afterPack] Applied icon to ${exePath}`);
};
