//! Startup guard for the WebGL particle field.
//!
//! On some systems, creating the field's WebGL context can hang inside the GL
//! driver, leaving a blank, frozen window. The page records "starting" in a
//! small per-user state file (synced to disk) before it creates the context,
//! and "idle" once the first frame is drawn. A launch that finds "starting"
//! knows the previous start never finished, so it shows the still fallback
//! instead; the page turns the field off after two such starts in a row.
//! `CONSILIUM_PARTICLES=0` skips WebGL without touching the state file.

use std::ffi::OsStr;

use serde::Serialize;

/// Storage for the one-line guard state. The desktop uses a file next to the
/// session history; tests use memory.
pub trait StateFile {
    fn read_state(&self) -> Option<String>;
    fn write_state(&self, contents: &str) -> Result<(), String>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
struct GuardState {
    starting: bool,
    consecutive_freezes: u32,
}

impl GuardState {
    /// `"<starting|idle> <consecutive freezes>"`; anything unreadable is idle.
    fn parse(text: Option<&str>) -> Self {
        let mut parts = text.unwrap_or_default().split_whitespace();
        let starting = parts.next() == Some("starting");
        let consecutive_freezes = parts.next().and_then(|n| n.parse().ok()).unwrap_or(0);
        Self {
            starting,
            consecutive_freezes,
        }
    }

    fn render(self) -> String {
        let phase = if self.starting { "starting" } else { "idle" };
        format!("{phase} {}\n", self.consecutive_freezes)
    }
}

/// What the page needs to decide how to start the field.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ParticleCheck {
    /// GL will draw in software, so the animated field would keep a CPU core
    /// busy. WebKitGTK hides the renderer name from the page, so this is
    /// decided here.
    pub software_gl: bool,
    /// `CONSILIUM_PARTICLES=0` is set.
    pub env_disabled: bool,
    /// The previous launch began starting the field and never finished.
    pub previous_froze: bool,
    /// Starts in a row that never finished, including the previous one.
    pub consecutive_freezes: u32,
}

/// Linux: GL draws in software when no GPU device node exists, or when the
/// user asked Mesa for a software rasterizer.
pub fn software_gl(env: impl Fn(&str) -> Option<String>, gpu_device_present: bool) -> bool {
    let forced = env("LIBGL_ALWAYS_SOFTWARE").is_some_and(|value| {
        value == "1" || value.eq_ignore_ascii_case("true") || value.eq_ignore_ascii_case("yes")
    }) || env("GALLIUM_DRIVER")
        .is_some_and(|value| matches!(value.as_str(), "llvmpipe" | "softpipe" | "swrast"));
    forced || !gpu_device_present
}

/// `CONSILIUM_PARTICLES=0` turns the WebGL field off for the session.
pub fn disabled_by_env(value: Option<&OsStr>) -> bool {
    value.is_some_and(|value| value == "0")
}

/// Run once at page start. A leftover "starting" counts as a freeze and is
/// cleared, so the launch after this one tries the field again.
pub fn check(file: &impl StateFile, env_disabled: bool, software_gl: bool) -> ParticleCheck {
    if env_disabled {
        return ParticleCheck {
            software_gl,
            env_disabled: true,
            previous_froze: false,
            consecutive_freezes: 0,
        };
    }
    let state = GuardState::parse(file.read_state().as_deref());
    if !state.starting {
        return ParticleCheck {
            software_gl,
            env_disabled: false,
            previous_froze: false,
            consecutive_freezes: state.consecutive_freezes,
        };
    }
    let consecutive_freezes = state.consecutive_freezes.saturating_add(1);
    // If this write fails, the next launch sees "starting" again and also
    // skips the field, which is the safe direction.
    let _ = file.write_state(
        &GuardState {
            starting: false,
            consecutive_freezes,
        }
        .render(),
    );
    ParticleCheck {
        software_gl,
        env_disabled: false,
        previous_froze: true,
        consecutive_freezes,
    }
}

/// Called right before the page creates the WebGL context.
pub fn begin(file: &impl StateFile) -> Result<(), String> {
    let state = GuardState::parse(file.read_state().as_deref());
    file.write_state(
        &GuardState {
            starting: true,
            consecutive_freezes: state.consecutive_freezes,
        }
        .render(),
    )
}

/// Called once the context exists and the first frame is drawn.
pub fn finish(file: &impl StateFile) -> Result<(), String> {
    file.write_state(&GuardState::default().render())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Default)]
    struct MemoryFile(RefCell<Option<String>>);

    impl StateFile for MemoryFile {
        fn read_state(&self) -> Option<String> {
            self.0.borrow().clone()
        }
        fn write_state(&self, contents: &str) -> Result<(), String> {
            *self.0.borrow_mut() = Some(contents.to_string());
            Ok(())
        }
    }

    fn check_now(file: &MemoryFile) -> ParticleCheck {
        check(file, false, false)
    }

    #[test]
    fn a_clean_start_leaves_no_freeze_behind() {
        let file = MemoryFile::default();
        assert!(!check_now(&file).previous_froze);
        begin(&file).unwrap();
        finish(&file).unwrap();
        let next = check_now(&file);
        assert!(!next.previous_froze);
        assert_eq!(next.consecutive_freezes, 0);
    }

    #[test]
    fn a_start_that_never_finished_is_reported_once_then_retried() {
        let file = MemoryFile::default();
        begin(&file).unwrap(); // the app froze or was killed here

        let after_freeze = check_now(&file);
        assert!(after_freeze.previous_froze);
        assert_eq!(after_freeze.consecutive_freezes, 1);

        // the following launch tries again instead of skipping forever
        let retry = check_now(&file);
        assert!(!retry.previous_froze);
        assert_eq!(retry.consecutive_freezes, 1);
    }

    #[test]
    fn two_freezes_in_a_row_are_counted_and_a_success_resets_them() {
        let file = MemoryFile::default();
        begin(&file).unwrap();
        assert_eq!(check_now(&file).consecutive_freezes, 1);
        begin(&file).unwrap();
        let second = check_now(&file);
        assert!(second.previous_froze);
        assert_eq!(second.consecutive_freezes, 2);

        begin(&file).unwrap();
        finish(&file).unwrap();
        assert_eq!(check_now(&file).consecutive_freezes, 0);
    }

    #[test]
    fn the_environment_switch_skips_webgl_without_touching_state() {
        let file = MemoryFile::default();
        begin(&file).unwrap();
        let disabled = check(&file, true, false);
        assert!(disabled.env_disabled);
        assert!(!disabled.previous_froze);
        // the pending start is still reported once the switch is removed
        assert!(check_now(&file).previous_froze);
    }

    #[test]
    fn software_gl_is_reported_without_a_gpu_or_when_requested() {
        let none = |_: &str| None;
        assert!(!software_gl(none, true));
        assert!(software_gl(none, false));
        let forced = |key: &str| (key == "LIBGL_ALWAYS_SOFTWARE").then(|| "1".to_string());
        assert!(software_gl(forced, true));
        let gallium = |key: &str| (key == "GALLIUM_DRIVER").then(|| "llvmpipe".to_string());
        assert!(software_gl(gallium, true));
        let hardware = |key: &str| (key == "GALLIUM_DRIVER").then(|| "radeonsi".to_string());
        assert!(!software_gl(hardware, true));
        let off = |key: &str| (key == "LIBGL_ALWAYS_SOFTWARE").then(|| "0".to_string());
        assert!(!software_gl(off, true));
        // the check passes the answer through unchanged
        let file = MemoryFile::default();
        assert!(check(&file, false, true).software_gl);
        assert!(!check(&file, false, false).software_gl);
    }

    #[test]
    fn only_zero_disables_the_field() {
        assert!(disabled_by_env(Some(OsStr::new("0"))));
        for value in ["1", "", "false", "00"] {
            assert!(!disabled_by_env(Some(OsStr::new(value))), "{value:?}");
        }
        assert!(!disabled_by_env(None));
    }

    #[test]
    fn unreadable_counts_read_as_zero() {
        for text in ["", "garbage", "idle", "starting x", "idle -3"] {
            let file = MemoryFile(RefCell::new(Some(text.to_string())));
            let result = check_now(&file);
            // a pending start still counts once, on top of the unreadable zero
            let expected = u32::from(text.starts_with("starting"));
            assert_eq!(result.consecutive_freezes, expected, "{text:?}");
            assert_eq!(
                result.previous_froze,
                text.starts_with("starting"),
                "{text:?}"
            );
        }
    }
}
