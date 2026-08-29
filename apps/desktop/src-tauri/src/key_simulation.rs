use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KeySimulationAction {
    Tap,
    Press,
    Release,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VirtualKeyTarget {
    RightCommand,
    LeftCommand,
    RightOption,
    LeftOption,
    RightControl,
    LeftControl,
    Function,
    F5,
    F6,
    Space,
    Custom(u16),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeySimulationCapabilities {
    pub supported: bool,
    pub platform: String,
    pub default_target: VirtualKeyTarget,
    pub permission_required: bool,
    pub permission_granted: Option<bool>,
}

pub fn check_capabilities() -> KeySimulationCapabilities {
    #[cfg(target_os = "macos")]
    {
        KeySimulationCapabilities {
            supported: true,
            platform: "macos".into(),
            default_target: VirtualKeyTarget::RightCommand,
            permission_required: true,
            permission_granted: None,
        }
    }
    #[cfg(target_os = "windows")]
    {
        KeySimulationCapabilities {
            supported: true,
            platform: "windows".into(),
            default_target: VirtualKeyTarget::RightControl,
            permission_required: false,
            permission_granted: Some(true),
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        KeySimulationCapabilities {
            supported: false,
            platform: "other".into(),
            default_target: VirtualKeyTarget::RightCommand,
            permission_required: false,
            permission_granted: None,
        }
    }
}

pub async fn check_permission(
    mut capabilities: KeySimulationCapabilities,
) -> KeySimulationCapabilities {
    #[cfg(target_os = "macos")]
    {
        capabilities.permission_granted =
            Some(tauri_plugin_macos_permissions::check_accessibility_permission().await);
    }
    capabilities
}

pub async fn request_permission() -> KeySimulationCapabilities {
    #[cfg(target_os = "macos")]
    tauri_plugin_macos_permissions::request_accessibility_permission().await;

    check_permission(check_capabilities()).await
}

pub async fn ensure_permission() -> Result<(), String> {
    let capabilities = check_permission(check_capabilities()).await;
    if capabilities.permission_required && capabilities.permission_granted != Some(true) {
        return Err(
            "JoyDSH 尚未获得 macOS 辅助功能权限。请在系统设置 > 隐私与安全性 > 辅助功能中允许 JoyDSH。"
                .into(),
        );
    }
    Ok(())
}

pub fn simulate_key(target: &VirtualKeyTarget, action: &KeySimulationAction) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        platform::simulate_macos(target, action)
    }
    #[cfg(target_os = "windows")]
    {
        platform::simulate_windows(target, action)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (target, action);
        Err("当前操作系统暂不支持按键模拟".into())
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use std::ffi::c_void;
    use std::thread;
    use std::time::Duration;

    type CGEventRef = *mut c_void;
    type CGEventSourceRef = *mut c_void;
    type CGKeyCode = u16;
    type CGEventTapLocation = u32;

    const K_CG_HID_EVENT_TAP: CGEventTapLocation = 0;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventCreateKeyboardEvent(
            source: CGEventSourceRef,
            virtual_key: CGKeyCode,
            key_down: bool,
        ) -> CGEventRef;
        fn CGEventPost(tap: CGEventTapLocation, event: CGEventRef);
        fn CFRelease(cf: *const c_void);
    }

    pub fn to_macos_key_code(target: &VirtualKeyTarget) -> u16 {
        match target {
            VirtualKeyTarget::RightCommand => 54, // 0x36 kVK_RightCommand
            VirtualKeyTarget::LeftCommand => 55,  // 0x37 kVK_Command
            VirtualKeyTarget::RightOption => 61,  // 0x3D kVK_RightOption
            VirtualKeyTarget::LeftOption => 58,   // 0x3A kVK_Option
            VirtualKeyTarget::RightControl => 62, // 0x3E kVK_RightControl
            VirtualKeyTarget::LeftControl => 59,  // 0x3B kVK_Control
            VirtualKeyTarget::Function => 63,     // 0x3F kVK_Function
            VirtualKeyTarget::F5 => 96,           // 0x60 kVK_F5
            VirtualKeyTarget::F6 => 97,           // 0x61 kVK_F6
            VirtualKeyTarget::Space => 49,        // 0x31 kVK_Space
            VirtualKeyTarget::Custom(code) => *code,
        }
    }

    pub fn post_key_event(key_code: u16, key_down: bool) -> Result<(), String> {
        unsafe {
            let event = CGEventCreateKeyboardEvent(std::ptr::null_mut(), key_code, key_down);
            if event.is_null() {
                return Err(format!("无法创建 macOS 按键事件 (keyCode: {key_code})"));
            }
            CGEventPost(K_CG_HID_EVENT_TAP, event);
            CFRelease(event as *const c_void);
        }
        Ok(())
    }

    pub fn simulate_macos(
        target: &VirtualKeyTarget,
        action: &KeySimulationAction,
    ) -> Result<(), String> {
        let key_code = to_macos_key_code(target);
        match action {
            KeySimulationAction::Press => post_key_event(key_code, true),
            KeySimulationAction::Release => post_key_event(key_code, false),
            KeySimulationAction::Tap => {
                post_key_event(key_code, true)?;
                thread::sleep(Duration::from_millis(30));
                post_key_event(key_code, false)?;
                Ok(())
            }
        }
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::*;
    use std::mem;
    use std::thread;
    use std::time::Duration;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_APPS, VK_F5,
        VK_F6, VK_LCONTROL, VK_LMENU, VK_LWIN, VK_RCONTROL, VK_RMENU, VK_RWIN, VK_SPACE,
    };

    pub fn to_windows_vk(target: &VirtualKeyTarget) -> u16 {
        match target {
            VirtualKeyTarget::RightCommand => VK_RWIN,
            VirtualKeyTarget::LeftCommand => VK_LWIN,
            VirtualKeyTarget::RightOption => VK_RMENU,
            VirtualKeyTarget::LeftOption => VK_LMENU,
            VirtualKeyTarget::RightControl => VK_RCONTROL,
            VirtualKeyTarget::LeftControl => VK_LCONTROL,
            VirtualKeyTarget::Function => VK_APPS,
            VirtualKeyTarget::F5 => VK_F5,
            VirtualKeyTarget::F6 => VK_F6,
            VirtualKeyTarget::Space => VK_SPACE,
            VirtualKeyTarget::Custom(code) => *code,
        }
    }

    pub fn post_key_event(vk: u16, key_down: bool) -> Result<(), String> {
        let flags = if key_down { 0 } else { KEYEVENTF_KEYUP };
        let mut input: INPUT = unsafe { mem::zeroed() };
        input.r#type = INPUT_KEYBOARD;
        input.Anonymous.ki = KEYBDINPUT {
            wVk: vk,
            wScan: 0,
            dwFlags: flags,
            time: 0,
            dwExtraInfo: 0,
        };
        let sent = unsafe { SendInput(1, &input, mem::size_of::<INPUT>() as i32) };
        if sent == 1 {
            Ok(())
        } else {
            Err(format!("SendInput 模拟按键失败 (vk: {vk})"))
        }
    }

    pub fn simulate_windows(
        target: &VirtualKeyTarget,
        action: &KeySimulationAction,
    ) -> Result<(), String> {
        let vk = to_windows_vk(target);
        match action {
            KeySimulationAction::Press => post_key_event(vk, true),
            KeySimulationAction::Release => post_key_event(vk, false),
            KeySimulationAction::Tap => {
                post_key_event(vk, true)?;
                thread::sleep(Duration::from_millis(30));
                post_key_event(vk, false)?;
                Ok(())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_and_deserializes_key_targets_and_actions() {
        let target = VirtualKeyTarget::RightCommand;
        let serialized = serde_json::to_string(&target).unwrap();
        assert_eq!(serialized, "\"rightCommand\"");
        let deserialized: VirtualKeyTarget = serde_json::from_str(&serialized).unwrap();
        assert_eq!(deserialized, target);

        let custom = VirtualKeyTarget::Custom(123);
        let custom_json = serde_json::to_string(&custom).unwrap();
        assert_eq!(custom_json, "{\"custom\":123}");
        let custom_parsed: VirtualKeyTarget = serde_json::from_str(&custom_json).unwrap();
        assert_eq!(custom_parsed, custom);

        let action = KeySimulationAction::Tap;
        let action_json = serde_json::to_string(&action).unwrap();
        assert_eq!(action_json, "\"tap\"");
        let action_parsed: KeySimulationAction = serde_json::from_str(&action_json).unwrap();
        assert_eq!(action_parsed, action);
    }

    #[test]
    fn reports_platform_capabilities() {
        let caps = check_capabilities();
        assert!(!caps.platform.is_empty());
        #[cfg(target_os = "macos")]
        {
            assert!(caps.supported);
            assert_eq!(caps.platform, "macos");
            assert_eq!(caps.default_target, VirtualKeyTarget::RightCommand);
            assert!(caps.permission_required);
            assert_eq!(caps.permission_granted, None);
            assert_eq!(
                platform::to_macos_key_code(&VirtualKeyTarget::RightCommand),
                54
            );
            assert_eq!(platform::to_macos_key_code(&VirtualKeyTarget::Function), 63);
        }
    }
}
