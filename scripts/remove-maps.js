import { glob } from 'glob';
import { unlink } from 'fs/promises';
import { join } from 'path';

async function removeMapFiles() {
  try {
    const mapFiles = await glob('dist/**/*.map');
    if (mapFiles.length === 0) {
      console.log('No map files found.');
      return;
    }
    await Promise.all(mapFiles.map(file => unlink(file)));
    console.log(`Removed ${mapFiles.length} map file(s).`);
  } catch (error) {
    console.error('Error removing map files:', error);
    process.exit(1);
  }
}

removeMapFiles();
