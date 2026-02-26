use wasm_bindgen::prelude::*;
use web_sys::{XrSessionMode}; // XrSession not unused in this snippet specifically but good to have

#[wasm_bindgen]
pub async fn start_ar_session(mode: String) -> Result<(), JsValue> {
    let window = web_sys::window().ok_or("no window")?;
    let navigator = window.navigator();
    let xr_system = navigator.xr();

    // Request the Immersive AR session as per Functional Requirements
    let session = wasm_bindgen_futures::JsFuture::from(
        xr_system.request_session(XrSessionMode::ImmersiveAr)
    ).await?;

    // Logic for loading difficulty parameters (Story vs Challenge)
    // and starting the WebGL render loop would follow here.
    
    web_sys::console::log_1(&format!("Started AR session in {} mode", mode).into());
    
    Ok(())
}

#[wasm_bindgen]
pub fn boxes_collide(
    ax: f32, ay: f32, az: f32, ahx: f32, ahy: f32, ahz: f32,
    bx: f32, by: f32, bz: f32, bhx: f32, bhy: f32, bhz: f32,
) -> bool {
    let a = Cuboid::new([ahx, ahy, ahz].into());
    let b = Cuboid::new([bhx, bhy, bhz].into());

    let a_iso = Isometry::translation(ax, ay, az);
    let b_iso = Isometry::translation(bx, by, bz);

    query::intersection_test(&a_iso, &a, &b_iso, &b).unwrap_or(false)
}
