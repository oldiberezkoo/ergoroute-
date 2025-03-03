import { config } from "../../utils/config.rediect"
import chokidar from 'chokidar';

class Parse {
  path: string;

  constructor() {
    this.path = config.basePath as string;
  }

  setWatcher() {
    const watcher = chokidar.watch(this.path, {
      persistent: true,
      ignored: (path, stats) => stats?.isFile() && !path.endsWith('.ts'),
    });

    return watcher
  }
}
