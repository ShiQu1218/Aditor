//! 透過 Windows 音訊引擎依 PID 擷取；不開啟或存取目標程序。

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
            PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
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

pub(super) fn activate(pid: u32) -> Result<IAudioClient> {
    ensure!(pid != 0, "程序音訊擷取需要有效的 PID");
    let mut params = Box::new(AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: pid,
                ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
            },
        },
    });
    // 參數由完成回呼持有；即使等待逾時也不會提前釋放，不以 PropVariantClear 清除借用的 blob。
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
    // SAFETY: 呼叫端已在 MTA 初始化 COM；參數於非同步啟用完成前保持有效。
    let operation = unsafe {
        ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID,
            Some(&*variant),
            &handler,
        )
    }
    .context("啟用程序音訊介面失敗")?;
    completed
        .recv_timeout(Duration::from_secs(3))
        .context("等待程序音訊啟用逾時")?;
    let mut result = HRESULT(0);
    let mut interface = None;
    // SAFETY: 完成通知已收到，輸出指標有效；音訊介面仍在同一個 MTA 使用。
    unsafe { operation.GetActivateResult(&mut result, &mut interface) }?;
    result.ok().context("系統不支援程序音訊擷取")?;
    interface
        .context("程序音訊介面為空")?
        .cast()
        .map_err(Into::into)
}
