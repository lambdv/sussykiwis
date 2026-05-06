import { Color3, Mesh, MeshBuilder, Scene, StandardMaterial, Vector3 } from "@babylonjs/core";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";

export type PlayerTagState = {
  mesh: Mesh;
  material: StandardMaterial;
  texture: DynamicTexture;
  setTextColor: (color: string) => void;
};

export function createPlayerTag(scene: Scene, id: string, label: string): PlayerTagState {
  // Billboard the tag so it stays readable from any camera angle.
  const mesh = MeshBuilder.CreatePlane(`player-tag-${id}`, { width: 3.2, height: 0.85 }, scene);
  mesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
  mesh.isPickable = false;

  const texture = new DynamicTexture(`player-tag-texture-${id}`, { width: 512, height: 128 }, scene, false);
  texture.hasAlpha = true;
  const drawLabel = (color: string) => {
    // Redraw the player name so role-aware color changes stay server-driven.
    texture.drawText(label, 256, 86, "bold 64px Arial", color, "transparent", true);
  };

  drawLabel("#ffffff");

  const material = new StandardMaterial(`player-tag-material-${id}`, scene);
  material.diffuseTexture = texture;
  material.emissiveColor = Color3.White();
  material.specularColor = Color3.Black();
  material.backFaceCulling = false;
  material.useAlphaFromDiffuseTexture = true;

  mesh.material = material;
  mesh.position = new Vector3(0, 3.2, 0);

  return {
    mesh,
    material,
    texture,
    setTextColor: drawLabel,
  };
}
