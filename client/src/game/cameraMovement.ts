export function cameraRelativeMovement(inputX: number, inputZ: number, cameraAlpha: number) {
  // Rotate flat input so forward/right always match the camera's view angle.
  const cos = Math.cos(cameraAlpha);
  const sin = Math.sin(cameraAlpha);

  return {
    x: inputX * cos + inputZ * sin,
    z: -inputX * sin + inputZ * cos,
  };
}
