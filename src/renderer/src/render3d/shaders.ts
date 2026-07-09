export const VERT_SRC = `#version 300 es
void main() {
  vec2 p = vec2[3](vec2(-1., -1.), vec2(3., -1.), vec2(-1., 3.))[gl_VertexID];
  gl_Position = vec4(p, 0., 1.);
}
`

export const FRAG_SRC = `#version 300 es
precision highp float;
precision highp sampler3D;

uniform sampler3D uVol;
uniform sampler3D uLab;    // region palette indices (R8, NEAREST), 0 = none
uniform sampler2D uLabLut; // 256x1 RGBA palette; alpha 0 hides a region
uniform int   uHasLab;
uniform float uLabAlpha;   // region layer opacity
uniform vec3  uEye;
uniform vec3  uRight;
uniform vec3  uUp;
uniform vec3  uFwd;
uniform vec3  uHalfExt;
uniform vec2  uViewport;
uniform float uTanHalfFov;
uniform float uAspect;
uniform float uLo;       // display window in normalized texture space
uniform float uHi;
uniform float uBright;   // window span divisor: lower = wider span = dimmer
uniform float uDensity;  // composite extinction scale
uniform int   uMode;     // 0 = MIP, 1 = composite
uniform int   uSteps;

out vec4 outColor;

vec2 boxHit(vec3 ro, vec3 rd) {
  vec3 inv = 1.0 / rd;
  vec3 t0 = (-uHalfExt - ro) * inv;
  vec3 t1 = ( uHalfExt - ro) * inv;
  vec3 tn = min(t0, t1);
  vec3 tf = max(t0, t1);
  return vec2(max(max(tn.x, tn.y), tn.z), min(min(tf.x, tf.y), tf.z));
}

float win(float s) {
  // Widening the span (uBright < 1) keeps structure above the 2D window's
  // ceiling instead of clipping every projected maximum to white.
  float span = max((uHi - uLo) / max(uBright, 0.01), 1e-6);
  return clamp((s - uLo) / span, 0.0, 1.0);
}

// Front-most region sample along the ray: its palette color source-over the
// mode's own result. Returns color in rgb, coverage in a.
vec4 labelAt(vec3 tc) {
  float li = texture(uLab, tc).r;              // palette index / 255
  if (li < 0.001) return vec4(0.0);
  vec4 c = texture(uLabLut, vec2(li * 255.0 / 256.0 + 0.5 / 256.0, 0.5));
  if (c.a < 0.004) return vec4(0.0);           // hidden region
  return vec4(c.rgb, uLabAlpha);
}

void main() {
  vec2 ndc = (gl_FragCoord.xy / uViewport) * 2.0 - 1.0;
  vec3 rd = normalize(uFwd + ndc.x * uAspect * uTanHalfFov * uRight + ndc.y * uTanHalfFov * uUp);
  vec2 hit = boxHit(uEye, rd);
  if (hit.y <= max(hit.x, 0.0)) {
    outColor = vec4(0.0);
    return;
  }
  float t = max(hit.x, 0.0);
  float dt = (hit.y - t) / float(uSteps);
  // Jittered start hides step banding at low step counts.
  t += dt * fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);

  vec4 lab = vec4(0.0);

  if (uMode == 0) {
    float m = 0.0;
    for (int i = 0; i < uSteps; i++) {
      vec3 tc = (uEye + t * rd) / (2.0 * uHalfExt) + 0.5;
      m = max(m, texture(uVol, tc).r);
      if (uHasLab == 1 && lab.a == 0.0) lab = labelAt(tc);
      t += dt;
    }
    float g = win(m);
    vec3 col = vec3(g) * g;
    float alpha = g;
    if (lab.a > 0.0) {
      col = lab.rgb * lab.a + col * (1.0 - lab.a);
      alpha = lab.a + alpha * (1.0 - lab.a);
    }
    outColor = vec4(col, alpha);
  } else {
    vec3 col = vec3(0.0);
    float alpha = 0.0;
    for (int i = 0; i < uSteps; i++) {
      vec3 tc = (uEye + t * rd) / (2.0 * uHalfExt) + 0.5;
      float g = win(texture(uVol, tc).r);
      float a = 1.0 - exp(-g * uDensity * 60.0 * dt);
      col += (1.0 - alpha) * a * vec3(g);
      alpha += (1.0 - alpha) * a;
      if (uHasLab == 1 && lab.a == 0.0) lab = labelAt(tc);
      t += dt;
      if (alpha > 0.99) break;
    }
    if (lab.a > 0.0) {
      col = lab.rgb * lab.a + col * (1.0 - lab.a);
      alpha = lab.a + alpha * (1.0 - lab.a);
    }
    outColor = vec4(col, alpha);
  }
}
`
