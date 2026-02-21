export class HeartbeatManager {
  constructor(intervalMs = 5000) {
    this.intervalMs = intervalMs;
    this.map = new Map(); // doorId -> timestamp
  }

  beat(doorId) {
    if (!doorId) return;
    this.map.set(String(doorId), Date.now());
  }

  isAlive(doorId) {
    const last = this.map.get(String(doorId));
    if (!last) return false;
    return Date.now() - last <= this.intervalMs;
  }

  getStatuses(doorIds) {
    const result = {};
    for (const door of doorIds) {
      result[door] = this.isAlive(door);
    }
    return result;
  }

  getKnownDoors() {
    return Array.from(this.map.keys());
  }
}
