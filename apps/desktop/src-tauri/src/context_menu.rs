use tauri::{Runtime, plugin};
use webview2_com::{
    ContextMenuRequestedEventHandler,
    Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_COMMAND, ICoreWebView2, ICoreWebView2_11,
        ICoreWebView2ContextMenuRequestedEventArgs,
    },
    take_pwstr,
};
use windows::core::{BOOL, Interface, PWSTR, Result};

pub fn plugin<R: Runtime>() -> plugin::TauriPlugin<R> {
    plugin::Builder::new("context-menu-policy")
        .on_webview_ready(|webview| {
            if let Err(error) = webview.with_webview(|platform| {
                // Tauri supplies the controller on its owning UI thread.
                let result = unsafe { platform.controller().CoreWebView2() }.and_then(install);
                if let Err(error) = result {
                    eprintln!(
                        "Could not install WebView context menu filter: {}",
                        error.code()
                    );
                }
            }) {
                eprintln!("Could not access WebView for context menu filter: {error}");
            }
        })
        .build()
}

fn install(webview: ICoreWebView2) -> Result<()> {
    // COM references are acquired and used on the WebView's UI thread.
    unsafe {
        let settings = webview.Settings()?;
        settings.SetAreDefaultContextMenusEnabled(false)?;
        let webview = webview.cast::<ICoreWebView2_11>()?;
        let handler = ContextMenuRequestedEventHandler::create(Box::new(|_, args| {
            if let Some(args) = args {
                filter(&args)?;
            }
            Ok(())
        }));
        // The WebView owns the registered callback for its lifetime.
        webview.add_ContextMenuRequested(&handler, &mut 0)?;
        settings.SetAreDefaultContextMenusEnabled(true)
    }
}

fn filter(args: &ICoreWebView2ContextMenuRequestedEventArgs) -> Result<()> {
    // The event owns the target and collection. Item names use COM allocation.
    unsafe {
        args.SetHandled(true)?;
        let mut editable = BOOL::default();
        args.ContextMenuTarget()?.IsEditable(&mut editable)?;
        if !editable.as_bool() {
            return Ok(());
        }
        let items = args.MenuItems()?;
        let mut count = 0;
        items.Count(&mut count)?;
        for index in (0..count).rev() {
            let item = items.GetValueAtIndex(index)?;
            let mut kind = Default::default();
            item.Kind(&mut kind)?;
            let keep = if kind == COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_COMMAND {
                let mut name = PWSTR::null();
                item.Name(&mut name)?;
                matches!(
                    take_pwstr(name).as_str(),
                    "undo" | "redo" | "cut" | "copy" | "paste" | "delete" | "selectAll"
                )
            } else {
                false
            };
            if !keep {
                items.RemoveValueAtIndex(index)?;
                count -= 1;
            }
        }
        if count > 0 {
            args.SetHandled(false)?;
        }
        Ok(())
    }
}
