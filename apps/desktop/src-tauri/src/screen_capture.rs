use std::fs;
use std::process::Command;
use tempfile::tempdir;

#[tauri::command]
pub fn capture_screen(window: tauri::Window) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        capture_macos(&window)
    }
    #[cfg(target_os = "windows")]
    {
        capture_windows(&window)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Err("当前操作系统暂不支持原生屏幕截取".into())
    }
}

#[cfg(target_os = "macos")]
fn capture_macos(window: &tauri::Window) -> Result<String, String> {
    use objc2_app_kit::NSWindow;

    let ns_window = window
        .ns_window()
        .map_err(|error| format!("无法获取 JoyDSH 窗口句柄: {error}"))?
        as *mut NSWindow;
    let window_number = unsafe { (&*ns_window).windowNumber() };
    let temp_dir = tempdir().map_err(|e| format!("无法创建临时目录: {e}"))?;
    let path = temp_dir.path().join("joydsh-screenshot.png");
    let path = path.to_string_lossy().into_owned();

    let output = Command::new("/usr/sbin/screencapture")
        .args([
            "-x",
            "-o",
            "-l",
            &window_number.to_string(),
            "-t",
            "png",
            &path,
        ])
        .output()
        .map_err(|e| format!("执行 screencapture 失败: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("screencapture 命令退出异常: {stderr}"));
    }

    let bytes = fs::read(&path).map_err(|e| format!("读取截图数据失败: {e}"))?;
    if bytes.is_empty() {
        return Err("截图文件为空".into());
    }

    let encoded = base64_encode(&bytes);
    Ok(format!("data:image/png;base64,{encoded}"))
}

#[cfg(target_os = "windows")]
fn capture_windows(_window: &tauri::Window) -> Result<String, String> {
    let temp_dir = tempdir().map_err(|e| format!("无法创建临时目录: {e}"))?;
    let path = temp_dir.path().join("joydsh-screenshot.png");
    let path = path.to_string_lossy().into_owned();

    let ps_script = format!(
        "Add-Type -AssemblyName System.Drawing; \
        Add-Type @'\nusing System;\nusing System.Runtime.InteropServices;\npublic class Win32 {{\n  [DllImport(\"user32.dll\")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);\n  [DllImport(\"user32.dll\")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint flags);\n  public struct RECT {{ public int Left; public int Top; public int Right; public int Bottom; }}\n}}\n'@; \
        $handle = (Get-Process -Id {}).MainWindowHandle; \
        $rect = New-Object Win32+RECT; \
        if (-not [Win32]::GetWindowRect($handle, [ref]$rect)) {{ throw '无法读取 JoyDSH 窗口边界' }}; \
        $width = $rect.Right - $rect.Left; $height = $rect.Bottom - $rect.Top; \
        $bmp = New-Object Drawing.Bitmap $width, $height; \
        $graphics = [Drawing.Graphics]::FromImage($bmp); \
        $hdc = $graphics.GetHdc(); \
        try {{ if (-not [Win32]::PrintWindow($handle, $hdc, 2)) {{ throw '无法渲染 JoyDSH 窗口' }} }} finally {{ $graphics.ReleaseHdc($hdc) }}; \
        $bmp.Save('{path}', [Drawing.Imaging.ImageFormat]::Png); \
        $graphics.Dispose(); \
        $bmp.Dispose();",
        std::process::id(),
    );

    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &ps_script])
        .output()
        .map_err(|e| format!("执行 Windows 截图失败: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Windows 截图脚本执行失败: {stderr}"));
    }

    let bytes = fs::read(&path).map_err(|e| format!("读取截图数据失败: {e}"))?;
    if bytes.is_empty() {
        return Err("截图文件为空".into());
    }

    let encoded = base64_encode(&bytes);
    Ok(format!("data:image/png;base64,{encoded}"))
}

fn base64_encode(data: &[u8]) -> String {
    const STANDARD: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0];
        let b1 = chunk.get(1).copied().unwrap_or(0);
        let b2 = chunk.get(2).copied().unwrap_or(0);

        let n = ((b0 as u32) << 16) | ((b1 as u32) << 8) | (b2 as u32);

        result.push(STANDARD[((n >> 18) & 63) as usize] as char);
        result.push(STANDARD[((n >> 12) & 63) as usize] as char);

        if chunk.len() > 1 {
            result.push(STANDARD[((n >> 6) & 63) as usize] as char);
        } else {
            result.push('=');
        }

        if chunk.len() > 2 {
            result.push(STANDARD[(n & 63) as usize] as char);
        } else {
            result.push('=');
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_base64_correctly() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"hello world"), "aGVsbG8gd29ybGQ=");
    }
}
