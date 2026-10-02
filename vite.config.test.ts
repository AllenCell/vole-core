import { describe, expect, it } from "vitest";

import { glslTransform } from "./vite.config.js";
import fs from 'fs';

describe("GLSL transform", () => {
  const dir = './src/constants/shaders/';
  const files = fs.readdirSync(dir).map(file => dir + file);

  it.each(files)("escapes special characters in %s", (file) => {
    // Arrange
    const code = fs.readFileSync(file).toString();
    
    // Act
    const result = glslTransform(code, "shader.frag");
    const body = (result ?? "").replace("export default", "return");
    const evaluated = new Function(body)();

    // Assert
    expect(evaluated).to.equal(code);
  });
});
