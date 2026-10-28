//! Capture by PID through the Windows audio engine without opening or accessing the target process.

use std::{mem::ManuallyDrop, sync::mpsc, time::Duration};

use anyhow::{ensure, Context, Result};
use windows::{
    core::{implement, Interface, Ref, HRESULT},
    Win32::{
        Media::Audio::{
            ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
            IActivateAudioInterfaceCompletionHandler,
            IActivateAudioInterfaceCompletionHandler_Impl, IAudioClient,
            AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0,
            AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
            PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        },
        System::{
            Com::{
                IAgileObject, IAgileObject_Impl,
                StructuredStorage::{
                    PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0,
                },
                BLOB,
            },
            Variant::VT_BLOB,
        },
    },
};

#[implement(IActivateAudioInterfaceCompletionHandler, IAgileObject)]
struct Completion {
    done: mpsc::SyncSender<()>,
    _params: Box<AUDIOCLIENT_ACTIVATION_PARAMS>,
}

impl IAgileObject_Impl for Completion_Impl {}

impl IActivateAudioInterfaceCompletionHandler_Impl for Completion_Impl {
    fn ActivateCompleted(
        &self,
        _: Ref<'_, IActivateAudioInterfaceAsyncOperation>,
    ) -> windows::core::Result<()> {
        let _ = self.done.try_send(());
        Ok(())
    }
}

/// `include`: capture only the process tree; otherwise capture everything except it.
pub(super) fn activate(pid: u32, include: bool) -> Result<IAudioClient> {
    ensure!(pid != 0, "Process audio capture requires a valid PID");
    let mut params = Box::new(AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: pid,
                ProcessLoopbackMode: if include {
                    PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
                } else {
                    PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE
                },
            },
        },
    });
    // The completion callback owns the parameters until completion even on timeout; do not clear the borrowed blob with PropVariantClear.
    let variant = ManuallyDrop::new(PROPVARIANT {
        Anonymous: PROPVARIANT_0 {
            Anonymous: ManuallyDrop::new(PROPVARIANT_0_0 {
                vt: VT_BLOB,
                Anonymous: PROPVARIANT_0_0_0 {
                    blob: BLOB {
                        cbSize: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
                        pBlobData: (&mut *params as *mut AUDIOCLIENT_ACTIVATION_PARAMS).cast(),
                    },
                },
                ..Default::default()
            }),
        },
    });
    let (done, completed) = mpsc::sync_channel(1);
    let handler: IActivateAudioInterfaceCompletionHandler = Completion {
        done,
        _params: params,
    }
    .into();
    // SAFETY: The caller initialized COM in the MTA; parameters remain valid until asynchronous activation completes.
    let operation = unsafe {
        ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID,
            Some(&*variant),
            &handler,
        )
    }
    .context("Failed to activate process audio interface")?;
    completed
        .recv_timeout(Duration::from_secs(3))
        .context("Timed out waiting for process audio activation")?;
    let mut result = HRESULT(0);
    let mut interface = None;
    // SAFETY: Completion was received and output pointers are valid; audio interfaces remain in the same MTA.
    unsafe { operation.GetActivateResult(&mut result, &mut interface) }?;
    result.ok().context("The system does not support process audio capture")?;
    interface
        .context("Process audio interface is null")?
        .cast()
        .map_err(Into::into)
}
