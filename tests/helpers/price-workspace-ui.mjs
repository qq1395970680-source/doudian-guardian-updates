export async function openPriceWorkspace(page,productId,{scope='confirm'}={}){
 await page.locator('[data-view="workspace"]').click();
 await page.locator(`[data-workspace-scope="${scope==='pending'?'confirm':scope}"]`).click();
 await page.locator(`button[data-open-price-review="${productId}"]`).first().click();
 const dialog=page.locator('dialog[data-price-workspace]');await dialog.waitFor({state:'visible'});
 await dialog.locator('[data-review-id]').waitFor();return dialog;
}
export async function choosePriceStrategy(dialog,id){
 await dialog.getByRole('combobox',{name:'选择价格调整方案',exact:true}).selectOption(id);
 await dialog.locator('table[data-role="price-target-table"]').waitFor();
}
export async function closePriceWorkspace(page){
 await page.waitForFunction(()=>{const button=document.querySelector('dialog[data-price-workspace] > .section-head button');return button&&!button.disabled;});
 await page.keyboard.press('Escape');await page.locator('dialog[data-price-workspace]').waitFor({state:'hidden'});
}
export async function revealControl(control){
 const summaries=control.locator('xpath=ancestor::details/summary');
 for(let i=0;i<await summaries.count();i++){const summary=summaries.nth(i);if(!await summary.evaluate(el=>el.parentElement.open))await summary.click();}
}
