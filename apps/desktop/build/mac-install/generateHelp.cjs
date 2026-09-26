const fs = require('node:fs');
const path = require('node:path');

// One source for the website and DMG; embed the screenshot for offline use.
module.exports = function generateHelp() {
  const landing = path.resolve(__dirname, '../../../../landing');
  const imagePath = 'assets/mac-install/open-anyway-ru.png';
  const html = fs.readFileSync(path.join(landing, 'mac-install.html'), 'utf8');
  if (!html.includes(`src="${imagePath}"`)) {
    throw new Error('Mac installation guide screenshot is missing');
  }
  const image = fs.readFileSync(path.join(landing, imagePath)).toString('base64');
  fs.writeFileSync(path.join(__dirname, 'help.html'), html.replace(`src="${imagePath}"`, `src="data:image/png;base64,${image}"`));
};
if (require.main === module) module.exports();
