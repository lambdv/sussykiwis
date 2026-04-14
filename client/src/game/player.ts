export type Vec3 = { x: number; y: number; z: number };

export class PlayerScene {
  postion: Vec3;
  rotation: Vec3;

  constructor() {
    this.postion = {
      x: 0,
      y: 0,
      z: 0,
    };
    this.rotation = {
      x: 0,
      y: 0,
      z: 0,
    };
  }
}
