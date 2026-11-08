const particle_vertex = `
  precision highp float;
  attribute vec4 a_seed;
  uniform float u_time;
  uniform float u_aspect;
  uniform float u_pixel_ratio;
  uniform float u_pulse;
  uniform vec2 u_center;
  uniform vec3 u_pointer;
  varying vec3 v_color;
  varying float v_alpha;

  void main() {
    float tau = 6.2831853;
    float radius = 0.48 + pow(a_seed.x, 0.72) * 2.25;
    float arm = floor(a_seed.y * 5.0);
    float scatter = fract(a_seed.y * 5.0) - 0.5;
    float angle = arm * tau / 5.0 + radius * 1.65;
    angle += scatter * (0.24 + a_seed.x * 0.85);
    angle += u_time * (0.045 + 0.06 / radius);
    float wave = sin(angle * 3.0 + radius * 3.5 - u_time * 0.2);
    radius += wave * 0.12 + sin(a_seed.z * tau) * 0.12;
    vec3 p = vec3(cos(angle) * radius, sin(angle) * radius, 0.0);
    p.z = cos(a_seed.z * tau) * (0.12 + a_seed.x * 0.3);
    p.z += wave * 0.24 + sin(radius * 4.0 - u_time * 0.25) * 0.2;
    p.xy *= 1.0 + u_pulse * 0.045;

    float tilt = 0.66 + sin(u_time * 0.07) * 0.1;
    p.yz = mat2(cos(tilt), -sin(tilt), sin(tilt), cos(tilt)) * p.yz;
    float roll = -0.38 + sin(u_time * 0.04) * 0.08;
    p.xy = mat2(cos(roll), -sin(roll), sin(roll), cos(roll)) * p.xy;
    float depth = 4.8 - p.z;
    vec2 screen = p.xy * 1.62 / depth;
    screen.x /= u_aspect;
    screen += u_center;

    vec2 delta = screen - u_pointer.xy;
    delta.x *= u_aspect;
    float distance_to_mouse = length(delta);
    float force = exp(-distance_to_mouse * distance_to_mouse * 32.0);
    vec2 repel = normalize(delta + vec2(0.0001)) * force * 0.085;
    repel.x /= u_aspect;
    screen += repel * u_pointer.z;

    gl_Position = vec4(screen, 0.0, 1.0);
    float defocus = abs(p.z - 0.25);
    gl_PointSize = (1.05 + a_seed.w * 1.65 + defocus * 1.3);
    gl_PointSize *= u_pixel_ratio * 4.2 / depth;
    vec3 ice = vec3(0.36, 0.88, 1.0);
    vec3 violet = vec3(0.43, 0.32, 1.0);
    v_color = mix(ice, violet, smoothstep(0.25, 1.0, a_seed.x));
    v_color = mix(v_color, vec3(0.9, 0.98, 1.0), pow(a_seed.w, 12.0));
    v_alpha = (0.12 + a_seed.w * 0.33) / (1.0 + defocus * 0.7);
    v_alpha *= 1.0 + force * u_pointer.z + u_pulse * 0.3;
  }
`;

const particle_fragment = `
  precision mediump float;
  varying vec3 v_color;
  varying float v_alpha;

  void main() {
    float radius = length(gl_PointCoord - 0.5) * 2.0;
    if (radius > 1.0) discard;
    float glow = exp(-radius * radius * 4.5);
    gl_FragColor = vec4(v_color * glow * v_alpha, 1.0);
  }
`;

const screen_vertex = `
  attribute vec2 a_position;
  varying vec2 v_uv;

  void main() {
    v_uv = a_position * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;

const blur_fragment = `
  precision mediump float;
  uniform sampler2D u_image;
  uniform vec2 u_step;
  varying vec2 v_uv;

  void main() {
    vec3 color = texture2D(u_image, v_uv).rgb * 0.227027;
    color += texture2D(u_image, v_uv + u_step * 1.384615).rgb * 0.316216;
    color += texture2D(u_image, v_uv - u_step * 1.384615).rgb * 0.316216;
    color += texture2D(u_image, v_uv + u_step * 3.230769).rgb * 0.070270;
    color += texture2D(u_image, v_uv - u_step * 3.230769).rgb * 0.070270;
    gl_FragColor = vec4(color, 1.0);
  }
`;

const composite_fragment = `
  precision mediump float;
  uniform sampler2D u_image;
  uniform sampler2D u_bloom;
  uniform vec2 u_texel;
  uniform float u_aspect;
  uniform vec3 u_trail[6];
  varying vec2 v_uv;

  void main() {
    vec2 shift = (v_uv - 0.5) * u_texel * 1.8;
    vec3 color;
    color.r = texture2D(u_image, v_uv + shift).r;
    color.g = texture2D(u_image, v_uv).g;
    color.b = texture2D(u_image, v_uv - shift).b;
    color += texture2D(u_bloom, v_uv).rgb * 1.25;
    for (int i = 0; i < 6; i++) {
      vec2 delta = v_uv * 2.0 - 1.0 - u_trail[i].xy;
      delta.x *= u_aspect;
      float d = length(delta);
      float glow = exp(-d * d * 480.0) * 0.027;
      glow += exp(-d * d * 180000.0) * 0.32;
      color += vec3(0.45, 0.8, 1.0) * glow * u_trail[i].z;
    }
    color = vec3(1.0) - exp(-color * 1.25);
    gl_FragColor = vec4(color, 1.0);
  }
`;


export function create_nebula() {
  /** 创建自适应 GPU 星云，WebGL 失败时保留静态背景。
   *
   * Returns:
   *   含 burst() 的视觉控制器，不访问或修改学习数据。
   */
  const canvas = document.querySelector("#ambient-canvas");
  const reduced_motion = matchMedia("(prefers-reduced-motion: reduce)");
  const small_screen = matchMedia("(max-width: 760px)");
  const coarse_pointer = matchMedia("(pointer: coarse)");
  const initial_count = small_screen.matches ? 48000 : 200000;
  let particle_count = initial_count;
  let paused = reduced_motion.matches;
  document.body.classList.toggle("motion-paused", paused);
  let lost = false;
  let failed = false;
  let frame_id = 0;
  let last_time = 0;
  let elapsed = 0;
  let sample_start = 0;
  let frame_count = 0;
  let slow_samples = 0;
  let pulse = 0;
  let pixel_ratio = 1;
  let gl;
  let targets = [];
  const programs = [];
  const buffers = [];
  const pointer = { x: 0, y: 0, strength: 0 };
  const trail = new Float32Array(18);
  const center = [-0.24, 0.04];

  function update_scroll() {
    /** 更新真实文档滚动进度，不模拟虚假的浏览进度。 */
    const max_scroll = document.documentElement.scrollHeight - innerHeight;
    const progress = max_scroll > 0 ? scrollY / max_scroll : 0;
    document.querySelector("#scroll-progress").style.transform =
      `scaleY(${Math.max(0.02, Math.min(1, progress))})`;
  }

  window.addEventListener("scroll", update_scroll, { passive: true });
  new ResizeObserver(update_scroll).observe(document.body);
  update_scroll();

  function release_targets() {
    /** 释放离屏缓冲，避免窗口缩放时累积显存。 */
    for (const target of targets) {
      gl.deleteTexture(target.texture);
      gl.deleteFramebuffer(target.framebuffer);
    }
    targets = [];
  }

  function fallback() {
    /** 降级为静态背景，不让装饰层阻断账号和任务界面。 */
    failed = true;
    cancelAnimationFrame(frame_id);
    canvas.hidden = true;
    if (gl && !gl.isContextLost()) {
      release_targets();
      programs.forEach((program) => gl.deleteProgram(program));
      buffers.forEach((buffer) => gl.deleteBuffer(buffer));
    }
  }

  try {
    gl = canvas.getContext("webgl", {
      alpha: false,
      antialias: false,
      depth: false,
      powerPreference: "low-power",
    });
    if (!gl) throw new Error("WebGL unavailable");

    function compile_program(vertex_source, fragment_source) {
      /** 编译并链接着色器，失败时交给统一静态降级处理。 */
      const program = gl.createProgram();
      programs.push(program);
      for (const [type, source] of [
        [gl.VERTEX_SHADER, vertex_source],
        [gl.FRAGMENT_SHADER, fragment_source],
      ]) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
          const message = gl.getShaderInfoLog(shader);
          gl.deleteShader(shader);
          throw new Error(message);
        }
        gl.attachShader(program, shader);
        gl.deleteShader(shader);
      }
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(program));
      }
      const uniform_count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
      const uniforms = {};
      for (let index = 0; index < uniform_count; index += 1) {
        const name = gl.getActiveUniform(program, index).name;
        uniforms[name] = gl.getUniformLocation(program, name);
      }
      return { program, uniforms };
    }

    const particles = compile_program(particle_vertex, particle_fragment);
    const blur = compile_program(screen_vertex, blur_fragment);
    const composite = compile_program(screen_vertex, composite_fragment);
    const seeds = new Float32Array(initial_count * 4);
    for (let index = 0; index < seeds.length; index += 1) {
      seeds[index] = Math.random();
    }
    const seed_buffer = gl.createBuffer();
    buffers.push(seed_buffer);
    gl.bindBuffer(gl.ARRAY_BUFFER, seed_buffer);
    gl.bufferData(gl.ARRAY_BUFFER, seeds, gl.STATIC_DRAW);
    const seed_location = gl.getAttribLocation(particles.program, "a_seed");
    const quad_buffer = gl.createBuffer();
    buffers.push(quad_buffer);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad_buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1,
    ]), gl.STATIC_DRAW);
    for (const program of [blur, composite]) {
      program.position = gl.getAttribLocation(program.program, "a_position");
    }

    function create_target(width, height) {
      /** 创建带线性过滤的离屏颜色缓冲，用于粒子与 Bloom。 */
      const texture = gl.createTexture();
      const framebuffer = gl.createFramebuffer();
      const target = { texture, framebuffer, width, height };
      targets.push(target);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0,
        gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D, texture, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !==
          gl.FRAMEBUFFER_COMPLETE) {
        throw new Error("Incomplete particle framebuffer");
      }
      return target;
    }

    function resize() {
      /** 限制像素比和离屏分辨率，移动端避免高 DPR 带来的过度绘制。 */
      if (failed || lost) return;
      try {
        pixel_ratio = Math.min(devicePixelRatio || 1, 1.5,
          1920 / innerWidth, 1440 / innerHeight);
        canvas.width = Math.max(1, Math.floor(innerWidth * pixel_ratio));
        canvas.height = Math.max(1, Math.floor(innerHeight * pixel_ratio));
        if (small_screen.matches) {
          particle_count = Math.min(particle_count, 48000);
        }
        release_targets();
        create_target(canvas.width, canvas.height);
        const width = Math.max(1, Math.floor(canvas.width / 4));
        const height = Math.max(1, Math.floor(canvas.height / 4));
        create_target(width, height);
        create_target(width, height);
        if (paused) draw();
      } catch {
        fallback();
      }
    }

    function screen_pass(program, target, texture) {
      /** 绑定全屏三角形与目标，供模糊和最终合成共享。 */
      gl.bindFramebuffer(gl.FRAMEBUFFER, target?.framebuffer || null);
      gl.viewport(0, 0, target?.width || canvas.width,
        target?.height || canvas.height);
      gl.useProgram(program.program);
      gl.bindBuffer(gl.ARRAY_BUFFER, quad_buffer);
      gl.enableVertexAttribArray(program.position);
      gl.vertexAttribPointer(program.position, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(program.uniforms.u_image, 0);
    }

    function draw() {
      /** 执行粒子、双向低分辨率 Bloom 与轻微色散合成四个通道。 */
      if (failed || lost || !targets.length) return;
      const ready = document.body.dataset.account === "ready";
      const target_x = small_screen.matches ? 0.12 : ready ? 0.35 : -0.24;
      const target_y = small_screen.matches ? 0.48 : ready ? 0.26 : 0.04;
      center[0] += (target_x - center[0]) * (paused ? 1 : 0.025);
      center[1] += (target_y - center[1]) * (paused ? 1 : 0.025);
      const aspect = canvas.width / canvas.height;
      gl.bindFramebuffer(gl.FRAMEBUFFER, targets[0].framebuffer);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(particles.program);
      gl.bindBuffer(gl.ARRAY_BUFFER, seed_buffer);
      gl.enableVertexAttribArray(seed_location);
      gl.vertexAttribPointer(seed_location, 4, gl.FLOAT, false, 0, 0);
      const uniforms = particles.uniforms;
      gl.uniform1f(uniforms.u_time, elapsed);
      gl.uniform1f(uniforms.u_aspect, aspect);
      gl.uniform1f(uniforms.u_pixel_ratio, pixel_ratio);
      gl.uniform1f(uniforms.u_pulse, pulse);
      gl.uniform2fv(uniforms.u_center, center);
      gl.uniform3f(uniforms.u_pointer, pointer.x, pointer.y, pointer.strength);
      gl.drawArrays(gl.POINTS, 0, particle_count);
      gl.disableVertexAttribArray(seed_location);
      gl.disable(gl.BLEND);

      screen_pass(blur, targets[1], targets[0].texture);
      gl.uniform2f(blur.uniforms.u_step, 4 / canvas.width, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      screen_pass(blur, targets[2], targets[1].texture);
      gl.uniform2f(blur.uniforms.u_step, 0, 1 / targets[1].height);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.disableVertexAttribArray(blur.position);

      screen_pass(composite, null, targets[0].texture);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, targets[2].texture);
      gl.uniform1i(composite.uniforms.u_bloom, 1);
      gl.uniform2f(composite.uniforms.u_texel,
        1 / canvas.width, 1 / canvas.height);
      gl.uniform1f(composite.uniforms.u_aspect, aspect);
      gl.uniform3fv(composite.uniforms["u_trail[0]"], trail);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.disableVertexAttribArray(composite.position);
    }

    function frame(now) {
      /** 以墙钟计算动画和 FPS，低帧率持续出现时递减实际粒子数量。 */
      frame_id = 0;
      if (paused || lost || failed || document.hidden) return;
      const delta = last_time ? Math.min((now - last_time) / 1000, 0.05) : 0;
      last_time = now;
      elapsed += delta;
      pulse *= Math.exp(-delta * 2);
      const ease = 1 - Math.exp(-delta * 12);
      for (let index = 5; index >= 0; index -= 1) {
        const offset = index * 3;
        const previous = (index - 1) * 3;
        const x = index === 0 ? pointer.x : trail[previous];
        const y = index === 0 ? pointer.y : trail[previous + 1];
        trail[offset] += (x - trail[offset]) * ease;
        trail[offset + 1] += (y - trail[offset + 1]) * ease;
        trail[offset + 2] +=
          (pointer.strength * (1 - index / 7) - trail[offset + 2]) * ease;
      }
      draw();
      frame_count += 1;
      if (!sample_start) sample_start = now;
      if (now - sample_start >= 1200) {
        const fps = Math.round(frame_count * 1000 / (now - sample_start));
        slow_samples = fps < 30 ? slow_samples + 1 : 0;
        if (slow_samples >= 3 && particle_count > 24000) {
          particle_count = Math.max(24000, Math.floor(particle_count * 0.65));
          slow_samples = 0;
        }
        frame_count = 0;
        sample_start = now;
      }
      frame_id = requestAnimationFrame(frame);
    }

    function resume() {
      /** 防止重复帧循环；后台标签恢复后重新开始 FPS 采样。 */
      cancelAnimationFrame(frame_id);
      last_time = 0;
      sample_start = 0;
      frame_count = 0;
      if (!paused && !lost && !failed && !document.hidden) {
        frame_id = requestAnimationFrame(frame);
      }
    }

    reduced_motion.addEventListener("change", () => {
      paused = reduced_motion.matches;
      document.body.classList.toggle("motion-paused", paused);
      resume();
    });
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("resize", resize, { passive: true });
    window.addEventListener("pointermove", (event) => {
      if (paused || coarse_pointer.matches) return;
      pointer.x = event.clientX / innerWidth * 2 - 1;
      pointer.y = 1 - event.clientY / innerHeight * 2;
      pointer.strength = 1;
      const card = event.target.closest?.(".spotlight-card");
      if (card) {
        const rect = card.getBoundingClientRect();
        card.style.setProperty("--spot-x", `${event.clientX - rect.left}px`);
        card.style.setProperty("--spot-y", `${event.clientY - rect.top}px`);
      }
    }, { passive: true });
    document.documentElement.addEventListener("pointerleave", () => {
      pointer.strength = 0;
    });
    window.addEventListener("blur", () => { pointer.strength = 0; });
    canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      lost = true;
      cancelAnimationFrame(frame_id);
      canvas.hidden = true;
    });
    canvas.addEventListener("webglcontextrestored", () => {
      // 上下文恢复后旧资源无效，保持静态降级而不干扰正在进行的学习。
      fallback();
    });
    new MutationObserver(() => { if (paused) draw(); }).observe(
      document.body, { attributes: true, attributeFilter: ["data-account"] },
    );
    resize();
    if (!failed && !paused) resume();
  } catch (error) {
    console.warn("粒子背景已降级为静态模式：", error.message);
    fallback();
  }

  return {
    burst() {
      /** 完成任务时短暂增强星云辉光；尊重暂停和减少动态设置。 */
      if (!paused && !failed && !lost) pulse = 1;
    },
  };
}
