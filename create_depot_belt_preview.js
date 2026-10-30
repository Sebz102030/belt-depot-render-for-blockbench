/* Create Depot & Belt Preview - Blockbench plugin (v0.2.0)
 *
 * Adds two buttons to the "Reference Model" row of the Item Frame slot in Display mode:
 *   - Create Depot
 *   - Create Belt
 * Selecting one shows a depot/belt in the main viewport and places your model on it
 * the way Create renders items: FIXED (item frame) display values + Create's placement.
 * A small "Create Preview" panel holds the extra sliders (angle, stack size, belt position, slope).
 *
 * Placement constants (from memory of DepotRenderer / BeltRenderer, verify) are in CREATE below.
 */
(function () {
	'use strict';

	const ID = 'create_depot_belt_preview';
	const P = 16; // pixels per block (Blockbench scene units)

	const CREATE = {
		ANCHOR_Y: 15 / 16,
		FLAT_Y_OFFSET: -0.09375,
		FLAT_ROT_X: 90,
		ITEM_SCALE: 0.5,
		BLOCK_JITTER: 0.0625,
		LAYER_STEP: 1 / 16,
		FLAT_LAYER_ROT_Y: 10,
		SLOPE_ANGLE: 45,
		DEPOT_TOP: 13 / 16,
		BELT_TOP: 13 / 16,
		BELT_WIDTH: 14 / 16,
	};

	const State = { mode: 'depot', slope: 'none', kind: 'auto', count: 1, angle: 0, pos: 0.5, side: 0, seed: 0, yOff: -4 };

	let panel, origBar, refDepot, refBelt;
	let raf = 0, world = null, extras = null, depotMesh = null, beltGroup = null, beltBody = null;
	let lastSig = '', lastBuild = 0;

	const rad = d => d * Math.PI / 180;
	const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
	const T = (x, y, z) => new THREE.Matrix4().makeTranslation(x, y, z);
	const RX = a => new THREE.Matrix4().makeRotationX(rad(a));
	const RY = a => new THREE.Matrix4().makeRotationY(rad(a));
	const RZ = a => new THREE.Matrix4().makeRotationZ(rad(a));
	const S = s => new THREE.Matrix4().makeScale(s, s, s);

	class JRandom { // java.util.Random.nextFloat
		constructor(seed) {
			this.mask = (1n << 48n) - 1n;
			this.s = (BigInt(Math.trunc(seed)) ^ 0x5DEECE66Dn) & this.mask;
		}
		next(bits) {
			this.s = (this.s * 0x5DEECE66Dn + 0xBn) & this.mask;
			return Number(this.s >> (48n - BigInt(bits)));
		}
		nextFloat() { return this.next(24) / 16777216; }
	}

	function getBase() {
		return window.display_base || (Project && Project.model_3d && Project.model_3d.parent) || null;
	}
	function getScene() {
		if (window.display_scene) return window.display_scene;
		let o = getBase();
		while (o && o.parent) o = o.parent;
		return o;
	}
	function getFixed() {
		const s = Project && Project.display_settings && Project.display_settings.fixed;
		return {
			rotation: (s && s.rotation) || [0, 0, 0],
			translation: (s && s.translation) || [0, 0, 0],
			scale: (s && s.scale) || [1, 1, 1],
		};
	}
	function isFlat() {
		if (State.kind === 'flat') return true;
		if (State.kind === 'block') return false;
		return !!(Project && Project.front_gui_light);
	}

	// vanilla ItemTransform.apply order (translate, rotate XYZ, scale), in pixel units
	function fixedMatrix(d) {
		const t = d.translation.map(v => clamp(v, -80, 80));
		return T(t[0], t[1], t[2])
			.multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rad(d.rotation[0]), rad(d.rotation[1]), rad(d.rotation[2]), 'XYZ')))
			.multiply(new THREE.Matrix4().makeScale(Math.min(d.scale[0], 4), Math.min(d.scale[1], 4), Math.min(d.scale[2], 4)));
	}

	function slopeSign() {
		if (State.mode !== 'belt') return 0;
		return State.slope === 'up' ? 1 : State.slope === 'down' ? -1 : 0;
	}

	// One matrix per stacked layer: world (block centered at origin) -> model-centered item space
	function layerMatrices() {
		const flat = isFlat();
		const belt = State.mode === 'belt';
		const s = slopeSign();
		const M = T(-P / 2, -P / 2, -P / 2); // block center at origin
		if (!belt) {
			M.multiply(T(P / 2, CREATE.ANCHOR_Y * P + State.yOff, P / 2));
		} else {
			M.multiply(T(State.pos * P, (CREATE.ANCHOR_Y + (State.pos - 0.5) * s) * P + State.yOff, (0.5 + State.side) * P));
			M.multiply(RZ(CREATE.SLOPE_ANGLE * s));
		}
		M.multiply(RY(State.angle));
		if (flat) M.multiply(T(0, CREATE.FLAT_Y_OFFSET * P, 0)).multiply(RX(CREATE.FLAT_ROT_X));

		const count = clamp(Math.trunc(State.count) || 1, 1, 64);
		const layers = Math.floor(Math.floor(Math.log2(count)) / 2);
		const rnd = new JRandom((State.seed || 0) + count);
		const F = fixedMatrix(getFixed());
		const out = [];
		for (let i = 0; i <= layers; i++) {
			const L = M.clone();
			if (!flat) L.multiply(T(rnd.nextFloat() * CREATE.BLOCK_JITTER * i * P, 0, rnd.nextFloat() * CREATE.BLOCK_JITTER * i * P));
			out.push(L.multiply(S(CREATE.ITEM_SCALE)).multiply(F));
			M.multiply(RY(flat ? CREATE.FLAT_LAYER_ROT_Y : 0));
			M.multiply(flat ? T(0, 0, -CREATE.LAYER_STEP * P) : T(0, CREATE.LAYER_STEP * P, 0));
		}
		return out;
	}

	function box(w, h, d, color) {
		return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color }));
	}

	function ensureWorld() {
		if (world) return world;
		world = new THREE.Object3D();
		world.name = 'create_preview_world';

		depotMesh = box(P, CREATE.DEPOT_TOP * P, P, 0x8a8f98);
		depotMesh.position.set(0, -P / 2 + CREATE.DEPOT_TOP * P / 2, 0);
		world.add(depotMesh);

		beltGroup = new THREE.Object3D();
		beltBody = box(P * Math.SQRT2, 3, CREATE.BELT_WIDTH * P, 0x3b3b3f);
		beltGroup.add(beltBody);
		world.add(beltGroup);

		const light = new THREE.AmbientLight(0xffffff, 0.9);
		world.add(light);

		extras = new THREE.Object3D();
		world.add(extras);
		return world;
	}

	function syncPlaceholders() {
		const belt = State.mode === 'belt';
		depotMesh.visible = !belt;
		beltGroup.visible = belt;
		if (belt) {
			const s = slopeSign();
			beltBody.scale.x = s === 0 ? 1 / Math.SQRT2 : 1;
			beltGroup.position.set(0, -P / 2 + (CREATE.BELT_TOP * P - 1.5), 0);
			beltGroup.rotation.set(0, 0, rad(CREATE.SLOPE_ANGLE) * s);
		}
	}

	function hideHelpers(o) {
		o.traverse(c => { if (c.isLine || c.isLineSegments || c.isSprite || c.isPoints) c.visible = false; });
	}

	function rebuildExtras(mats) {
		while (extras.children.length) extras.remove(extras.children[0]);
		for (let i = 1; i < mats.length; i++) {
			const g = new THREE.Object3D();
			g.matrixAutoUpdate = false;
			g.matrix.copy(mats[i]);
			const c = Project.model_3d.clone(true);
			hideHelpers(c);
			g.add(c);
			extras.add(g);
		}
	}

	function applyFrame() {
		const base = getBase();
		if (!base || !Project || !Project.model_3d) return;
		const scene = getScene();
		const area = base.parent;
		if (area && area !== scene) { area.position.set(0, 0, 0); area.rotation.set(0, 0, 0); area.scale.set(1, 1, 1); }

		const mats = layerMatrices();
		mats[0].decompose(base.position, base.quaternion, base.scale);

		const sig = JSON.stringify([State, getFixed()]);
		const now = performance.now();
		if (sig !== lastSig || now - lastBuild > 700) {
			lastSig = sig; lastBuild = now;
			rebuildExtras(mats);
		}
		syncPlaceholders();
	}

	function restoreBase() {
		try {
			const slot = Project && Project.display_settings && Project.display_settings[DisplayMode.display_slot];
			if (DisplayMode.updateDisplayBase) DisplayMode.updateDisplayBase(slot);
		} catch (e) { /* ignore */ }
		try {
			const a = displayReferenceObjects.active;
			if (a && a.updateBasePosition) a.updateBasePosition();
		} catch (e) { /* ignore */ }
	}

	function isMine() {
		const a = displayReferenceObjects.active;
		return a === refDepot || a === refBelt;
	}

	function stop() {
		if (raf) cancelAnimationFrame(raf);
		raf = 0;
		if (world && world.parent) world.parent.remove(world);
		if (extras) while (extras.children.length) extras.remove(extras.children[0]);
		restoreBase();
	}

	function tick() {
		raf = requestAnimationFrame(tick);
		if (!isMine()) { stop(); return; }
		if (!Modes.display || !Project) return;
		State.mode = displayReferenceObjects.active === refBelt ? 'belt' : 'depot';
		try { applyFrame(); } catch (e) { console.error('[Create preview]', e); }
	}

	function makeRef(id, label, icon, mode) {
		let ref;
		try {
			ref = new refModel(id, { icon });
		} catch (e) {
			ref = { id, icon, models: [], pose_angles: {}, variant: undefined };
		}
		ref.name = label;
		ref.icon = icon;
		ref.initialized = true;
		ref.model = ensureWorld();
		ref.load = function (index) {
			try { displayReferenceObjects.clear(); } catch (e) { /* ignore */ }
			displayReferenceObjects.active = ref;
			State.mode = mode;
			const scene = getScene();
			if (scene && !world.parent) scene.add(world);
			lastSig = '';
			if (!raf) raf = requestAnimationFrame(tick);
		};
		ref.updateBasePosition = function () {
			if (displayReferenceObjects.active === ref && Modes.display) { try { applyFrame(); } catch (e) { /* ignore */ } }
		};
		return ref;
	}

	Plugin.register(ID, {
		title: 'Create Depot & Belt Preview',
		author: 'generated',
		description: 'Adds Create depot and belt to the Reference Model row of the Item Frame slot, using the item frame (fixed) display values.',
		about: 'In Display mode, select the Item Frame slot and use the new Create Depot / Create Belt reference models. Extra sliders are in the "Create Preview" panel. Placement constants are at the top of the file.',
		icon: 'view_in_ar',
		version: '0.2.0',
		variant: 'both',
		tags: ['Minecraft: Java Edition', 'Create'],
		onload() {
			refDepot = makeRef('create_depot', 'Create Depot', 'inbox', 'depot');
			refBelt = makeRef('create_belt', 'Create Belt', 'view_stream', 'belt');
			displayReferenceObjects.refmodels.create_depot = refDepot;
			displayReferenceObjects.refmodels.create_belt = refBelt;

			origBar = displayReferenceObjects.bar;
			displayReferenceObjects.bar = function (buttons) {
				if (Array.isArray(buttons) && buttons.includes('frame_top') && !buttons.includes('create_depot')) {
					buttons = buttons.concat(['create_depot', 'create_belt']);
				}
				return origBar.call(this, buttons);
			};

			panel = new Panel({
				id: ID,
				name: 'Create Preview',
				icon: 'view_in_ar',
				growable: false,
				resizable: true,
				condition: { modes: ['display'] },
				default_position: { slot: 'right_bar', float_position: [0, 0], float_size: [300, 300], height: 280 },
				component: {
					data() { return { s: State }; },
					template: `
					<div style="padding:8px;font-size:12px;display:grid;grid-template-columns:auto 1fr;gap:6px 8px;align-items:center;">
						<div style="grid-column:1/3;opacity:.7;">Item Frame slot &rarr; Reference Model &rarr; Create Depot / Create Belt</div>
						<label>Item type</label>
						<select v-model="s.kind"><option value="auto">Auto (front_gui_light)</option><option value="flat">Flat item</option><option value="block">Block item (3D)</option></select>
						<template v-if="s.mode === 'belt'">
							<label>Slope</label>
							<select v-model="s.slope"><option value="none">Flat</option><option value="up">Up</option><option value="down">Down</option></select>
							<label>Belt position</label>
							<input type="range" min="0" max="1" step="0.01" v-model.number="s.pos">
							<label>Side offset</label>
							<input type="range" min="-0.35" max="0.35" step="0.01" v-model.number="s.side">
						</template>
						<label>Height (px)</label>
						<input type="range" min="-8" max="8" step="0.5" v-model.number="s.yOff">
						<label>Item angle</label>
						<input type="range" min="0" max="359" step="1" v-model.number="s.angle">
						<label>Stack size</label>
						<input type="number" min="1" max="64" v-model.number="s.count" style="width:70px;">
						<label>Jitter seed</label>
						<input type="number" v-model.number="s.seed" style="width:90px;">
					</div>`
				}
			});
		},
		onunload() {
			stop();
			if (origBar) displayReferenceObjects.bar = origBar;
			delete displayReferenceObjects.refmodels.create_depot;
			delete displayReferenceObjects.refmodels.create_belt;
			if (panel) panel.delete();
			world = null;
		}
	});
})();
