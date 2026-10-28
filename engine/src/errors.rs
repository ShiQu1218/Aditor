use std::{error::Error, fmt};

macro_rules! message_errors {
    ($($name:ident),+ $(,)?) => {$(
        #[derive(Debug)]
        pub struct $name(pub String);
        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str(&self.0) }
        }
        impl Error for $name {}
    )+};
}
message_errors!(
    ProbeError,
    ProfileError,
    LayoutError,
    UnsupportedGame,
    UnknownGame,
    ValorantProfileError,
    BadRequest,
    Busy
);

#[derive(Debug)]
pub struct Cancelled;
impl fmt::Display for Cancelled {
    fn fmt(&self, _: &mut fmt::Formatter<'_>) -> fmt::Result {
        Ok(())
    }
}
impl Error for Cancelled {}
