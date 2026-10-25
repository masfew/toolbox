//! Puts a picture on the clipboard. On Windows it writes what arboard writes (a PNG, then CF_DIBV5,
//! from which Windows makes CF_DIB and CF_BITMAP for older apps), but quicker. arboard encodes the
//! PNG at the default compression; here a PNG the page already made goes on as it is, and a
//! capture's PNG uses png's fast setting, with the DIB built on another thread at the same time.

/// Puts a PNG on the clipboard as it is, with a CF_DIBV5 copy decoded from it for apps that don't
/// take PNGs. Copying sends a PNG from the page because handing raw pixels over took 0.3 s for a 4K
/// picture, most of the time a copy took.
#[cfg(windows)]
pub(crate) fn set_png(png: &[u8]) -> Result<(), String> {
    let (width, height, rgba) = decode_png(png)?;
    write(png, &dibv5(width, height, &rgba))
}

#[cfg(not(windows))]
pub(crate) fn set_png(png: &[u8]) -> Result<(), String> {
    let (width, height, rgba) = decode_png(png)?;
    set_image(width, height, &rgba)
}

/// Puts straight (not premultiplied) RGBA pixels on the clipboard.
#[cfg(windows)]
pub(crate) fn set_image(width: usize, height: usize, rgba: &[u8]) -> Result<(), String> {
    let (png, dib) = std::thread::scope(|s| {
        let png = s.spawn(|| encode_png(width, height, rgba));
        let dib = dibv5(width, height, rgba);
        (png.join(), dib)
    });
    let png = png.map_err(|_| "Couldn't encode the picture".to_string())??;
    write(&png, &dib)
}

#[cfg(windows)]
fn write(png: &[u8], dib: &[u8]) -> Result<(), String> {
    let _open = clipboard_win::Clipboard::new_attempts(10).map_err(|e| format!("Couldn't open the clipboard: {e}"))?;
    clipboard_win::raw::empty().map_err(|e| format!("Couldn't empty the clipboard: {e}"))?;
    // PNG first, as arboard does: some apps take the first picture format they know, and PNG keeps
    // transparency everywhere.
    let png_format = clipboard_win::register_format("PNG").ok_or("Couldn't register the PNG clipboard format")?;
    clipboard_win::raw::set_without_clear(png_format.get(), png).map_err(|e| e.to_string())?;
    clipboard_win::raw::set_without_clear(clipboard_win::formats::CF_DIBV5, dib).map_err(|e| e.to_string())
}

/// A PNG's pixels as 8-bit RGBA.
fn decode_png(png: &[u8]) -> Result<(usize, usize, Vec<u8>), String> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(png));
    decoder.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = decoder.read_info().map_err(|e| e.to_string())?;
    let mut buf = vec![0; reader.output_buffer_size().ok_or("The picture is too big")?];
    let info = reader.next_frame(&mut buf).map_err(|e| e.to_string())?;
    buf.truncate(info.buffer_size());
    let (width, height) = (info.width as usize, info.height as usize);
    // The page's encoder leaves out the alpha channel of a picture with no see-through pixels.
    let rgba = match info.color_type {
        png::ColorType::Rgba => buf,
        png::ColorType::Rgb => buf.chunks_exact(3).flat_map(|p| [p[0], p[1], p[2], 255]).collect(),
        png::ColorType::GrayscaleAlpha => buf.chunks_exact(2).flat_map(|p| [p[0], p[0], p[0], p[1]]).collect(),
        png::ColorType::Grayscale => buf.iter().flat_map(|&g| [g, g, g, 255]).collect(),
        png::ColorType::Indexed => return Err("Unexpected PNG colours".into()),
    };
    Ok((width, height, rgba))
}

#[cfg(not(windows))]
pub(crate) fn set_image(width: usize, height: usize, rgba: &[u8]) -> Result<(), String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    clipboard
        .set_image(arboard::ImageData { width, height, bytes: std::borrow::Cow::Borrowed(rgba) })
        .map_err(|e| e.to_string())
}

#[cfg(windows)]
fn encode_png(width: usize, height: usize, rgba: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(rgba.len() / 2);
    let mut encoder = png::Encoder::new(&mut out, width as u32, height as u32);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.set_compression(png::Compression::Fast);
    let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
    writer.write_image_data(rgba).map_err(|e| e.to_string())?;
    writer.finish().map_err(|e| e.to_string())?;
    Ok(out)
}

/// A BITMAPV5HEADER and the pixels as 32-bit BGRA with straight alpha, rows from the bottom up
/// (Word and WordPad can't paste a DIB stored top-down), as arboard writes it.
#[cfg(windows)]
fn dibv5(width: usize, height: usize, rgba: &[u8]) -> Vec<u8> {
    const HEADER: usize = 124;
    const BI_BITFIELDS: u32 = 3;
    const LCS_SRGB: u32 = 0x7352_4742;
    const LCS_GM_IMAGES: u32 = 4;
    let mut out = Vec::with_capacity(HEADER + rgba.len());
    let u32s = |out: &mut Vec<u8>, values: &[u32]| values.iter().for_each(|v| out.extend_from_slice(&v.to_le_bytes()));
    u32s(&mut out, &[HEADER as u32, width as u32, height as u32]);
    out.extend_from_slice(&1u16.to_le_bytes()); // planes
    out.extend_from_slice(&32u16.to_le_bytes()); // bits per pixel
    // Compression, image size, pixels per metre (x, y), colours used and important, then the
    // red, green, blue and alpha masks and the colour space.
    u32s(&mut out, &[BI_BITFIELDS, (width * height * 4) as u32, 0, 0, 0, 0, 0x00ff_0000, 0x0000_ff00, 0x0000_00ff, 0xff00_0000, LCS_SRGB]);
    out.extend_from_slice(&[0; 36]); // endpoints, unused with sRGB
    // Gamma (red, green, blue), intent, profile data and size, reserved.
    u32s(&mut out, &[0, 0, 0, LCS_GM_IMAGES, 0, 0, 0]);
    debug_assert_eq!(out.len(), HEADER);
    let row = width * 4;
    for y in (0..height).rev() {
        for p in rgba[y * row..(y + 1) * row].chunks_exact(4) {
            out.extend_from_slice(&[p[2], p[1], p[0], p[3]]);
        }
    }
    out
}
