// The rack's audio thread: runs the prism-fx chain on each 128-frame block.
// The page compiles the wasm module and hands it over in processorOptions;
// everything else arrives as messages on the port.

class PrismRack extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.x = null;
    this.bypass = false;
    this.queue = [];
    this.peak = [0, 0];
    this.frames = 0;
    this.slots = new Set();
    this.port.onmessage = (e) => (this.x ? this.handle(e.data) : this.queue.push(e.data));
    WebAssembly.instantiate(options.processorOptions.module, {}).then((instance) => {
      this.x = instance.exports;
      this.x.rack_init(sampleRate);
      this.text = this.x.text_buffer();
      this.queue.forEach((m) => this.handle(m));
      this.queue = [];
      this.port.postMessage({ op: 'ready' });
    });
  }

  // Views into wasm memory go stale when it grows, so make them fresh.
  view(ptr, n) { return new Float32Array(this.x.memory.buffer, ptr, n); }

  handle(m) {
    const x = this.x;
    switch (m.op) {
      case 'add': {
        // AudioWorkletGlobalScope has no TextEncoder: the page sends the id as bytes.
        const bytes = m.bytes;
        new Uint8Array(x.memory.buffer, this.text, bytes.length).set(bytes);
        const slot = x.rack_add(bytes.length);
        if (slot >= 0) {
          this.slots.add(slot);
          (m.params || []).forEach((v, i) => x.rack_set_param(slot, i, v));
        }
        this.port.postMessage({ op: 'added', req: m.req, slot });
        break;
      }
      case 'remove': x.rack_remove(m.slot); this.slots.delete(m.slot); break;
      case 'param': x.rack_set_param(m.slot, m.i, m.v); break;
      case 'on': x.rack_set_on(m.slot, m.on ? 1 : 0); break;
      case 'order': {
        const left = x.buffer_left();
        this.view(left, m.order.length).set(m.order);
        x.rack_set_order(m.order.length);
        break;
      }
      case 'sound': {
        const ptr = x.sound_buffer(m.frames);
        this.view(ptr, m.frames * 2).set(m.samples);
        x.rack_set_sound(m.slot, m.rate);
        break;
      }
      case 'bypass': this.bypass = m.on; break;
    }
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const input = inputs[0];
    const n = out[0].length;
    const inL = input && input[0], inR = input && (input[1] || input[0]);
    if (!this.x) {
      for (const ch of out) ch.fill(0);
      return true;
    }
    const x = this.x;
    const pl = x.buffer_left(), pr = x.buffer_right();
    const L = this.view(pl, n), R = this.view(pr, n);
    if (inL) { L.set(inL); R.set(inR); } else { L.fill(0); R.fill(0); }
    if (!this.bypass) x.rack_process(n);
    const L2 = this.view(pl, n), R2 = this.view(pr, n);
    out[0].set(L2);
    if (out[1]) out[1].set(R2);
    for (let i = 0; i < n; i++) {
      const a = Math.abs(L2[i]), b = Math.abs(R2[i]);
      if (a > this.peak[0]) this.peak[0] = a;
      if (b > this.peak[1]) this.peak[1] = b;
    }
    this.frames += n;
    if (this.frames >= sampleRate / 20) {
      const tele = {};
      this.slots.forEach((s) => { const t = x.rack_telemetry(s); if (t) tele[s] = t; });
      this.port.postMessage({ op: 'meter', peak: this.peak, tele });
      this.peak = [0, 0];
      this.frames = 0;
    }
    return true;
  }
}

registerProcessor('prism-rack', PrismRack);
